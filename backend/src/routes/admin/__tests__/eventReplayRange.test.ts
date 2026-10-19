/**
 * POST /event-replay/range – ledger-range replay of failed events (#2199)
 *
 * Covers input validation, dry-run default, rate limiting, single-flight
 * concurrency guard and audit logging of every attempt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockReplay = vi.fn();
const mockCreateAuditLog = vi.fn();
let mockAdmin: any = { id: 'sa-1', role: 'super_admin', banned: false };

vi.mock('../../../services/eventReplayService', () => ({
  EventReplayService: vi.fn().mockImplementation(() => ({
    replay: (...args: any[]) => mockReplay(...args),
    clearAndRebuild: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../config/database', () => ({
  Database: { createAuditLog: (...args: any[]) => mockCreateAuditLog(...args) },
}));

vi.mock('../../../middleware/auth', () => ({
  authenticateAdmin: (req: any, res: any, next: any) => {
    if (!mockAdmin) return res.status(401).json({ error: 'Authentication required' });
    req.admin = mockAdmin;
    next();
  },
  requireSuperAdmin: (req: any, res: any, next: any) => {
    if (req.admin?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  },
}));

import router, {
  __resetReplayStateForTests,
  createReplayRateLimiter,
  REPLAY_RATE_LIMIT_MAX,
} from '../eventReplay';

const sampleResult = {
  eventsProcessed: 10,
  eventsSkipped: 1,
  startLedger: 100,
  endLedger: 200,
  finalCursor: '200-3',
  errors: [{ ledger: 150, error: 'boom' }],
  duration: 42,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('POST /event-replay/range', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetReplayStateForTests();
    mockAdmin = { id: 'sa-1', role: 'super_admin', banned: false };
    mockReplay.mockResolvedValue(sampleResult);
    mockCreateAuditLog.mockResolvedValue({});
  });

  describe('auth', () => {
    it('returns 401 without credentials', async () => {
      mockAdmin = null;
      const res = await request(buildApp()).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(res.status).toBe(401);
      expect(mockReplay).not.toHaveBeenCalled();
    });

    it('returns 403 for non-super-admins', async () => {
      mockAdmin = { id: 'a-1', role: 'admin' };
      const res = await request(buildApp()).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(res.status).toBe(403);
      expect(mockReplay).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it.each([
      [{}, /required/],
      [{ startLedger: 100 }, /required/],
      [{ startLedger: 'abc', endLedger: 200 }, /positive integers/],
      [{ startLedger: 0, endLedger: 200 }, /positive integers/],
      [{ startLedger: 1.5, endLedger: 200 }, /positive integers/],
      [{ startLedger: 300, endLedger: 200 }, /greater than or equal/],
      [{ startLedger: 1, endLedger: 1_000_000 }, /must not exceed/],
      [{ startLedger: 1, endLedger: 2, batchSize: 0 }, /batchSize/],
      [{ startLedger: 1, endLedger: 2, batchSize: 201 }, /batchSize/],
      [{ startLedger: 1, endLedger: 2, maxRetries: 11 }, /maxRetries/],
    ])('rejects %o with 400', async (body, message) => {
      const res = await request(buildApp()).post('/event-replay/range').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
      expect(mockReplay).not.toHaveBeenCalled();
    });
  });

  describe('replay', () => {
    it('defaults to dry-run and passes the ledger range to the service', async () => {
      const res = await request(buildApp())
        .post('/event-replay/range')
        .send({ startLedger: 100, endLedger: 200 });

      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(true);
      expect(res.body.eventsProcessed).toBe(10);
      expect(mockReplay).toHaveBeenCalledWith({
        startLedger: 100,
        endLedger: 200,
        dryRun: true,
        batchSize: 100,
        maxRetries: 5,
      });
    });

    it('persists when dryRun is explicitly false', async () => {
      const res = await request(buildApp())
        .post('/event-replay/range')
        .send({ startLedger: 100, endLedger: 200, dryRun: false, batchSize: 50 });

      expect(res.status).toBe(200);
      expect(res.body.dryRun).toBe(false);
      expect(mockReplay).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: false, batchSize: 50 }),
      );
    });

    it('accepts parameters via query string', async () => {
      const res = await request(buildApp()).post(
        '/event-replay/range?startLedger=5&endLedger=10&dryRun=false',
      );

      expect(res.status).toBe(200);
      expect(mockReplay).toHaveBeenCalledWith(
        expect.objectContaining({ startLedger: 5, endLedger: 10, dryRun: false }),
      );
    });

    it('returns 500 when the service throws', async () => {
      mockReplay.mockRejectedValueOnce(new Error('Horizon down'));
      const res = await request(buildApp())
        .post('/event-replay/range')
        .send({ startLedger: 1, endLedger: 2 });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Horizon down');
    });

    it('rejects a concurrent replay with 409', async () => {
      let release!: () => void;
      mockReplay.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(sampleResult))),
      );
      const app = buildApp();

      const first = request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 }).then((r) => r);
      await vi.waitFor(() => expect(mockReplay).toHaveBeenCalledTimes(1));

      const second = await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(second.status).toBe(409);

      release();
      expect((await first).status).toBe(200);

      const third = await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(third.status).toBe(200);
    });
  });

  describe('audit', () => {
    it('records successful replays with the outcome summary', async () => {
      await request(buildApp())
        .post('/event-replay/range')
        .set('User-Agent', 'ops-cli')
        .send({ startLedger: 100, endLedger: 200, dryRun: false });

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'sa-1',
          action: 'EVENT_REPLAY_RANGE',
          resource: 'event-replay',
          resourceId: '100-200',
          userAgent: 'ops-cli',
          beforeState: expect.objectContaining({ startLedger: 100, endLedger: 200, dryRun: false }),
          afterState: expect.objectContaining({
            status: 'completed',
            eventsProcessed: 10,
            eventsSkipped: 1,
            errorCount: 1,
          }),
        }),
      );
    });

    it('records failed replays', async () => {
      mockReplay.mockRejectedValueOnce(new Error('Horizon down'));
      await request(buildApp()).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });

      expect(mockCreateAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          afterState: { status: 'failed', error: 'Horizon down' },
        }),
      );
    });

    it('does not fail the request when audit logging fails', async () => {
      mockCreateAuditLog.mockRejectedValueOnce(new Error('db down'));
      const res = await request(buildApp()).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(res.status).toBe(200);
    });

    it('does not audit requests rejected by validation', async () => {
      await request(buildApp()).post('/event-replay/range').send({ startLedger: 5, endLedger: 1 });
      expect(mockCreateAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 once the per-admin limit is exceeded', async () => {
      const app = buildApp();
      for (let i = 0; i < REPLAY_RATE_LIMIT_MAX; i++) {
        const ok = await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
        expect(ok.status).toBe(200);
      }

      const limited = await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(mockReplay).toHaveBeenCalledTimes(REPLAY_RATE_LIMIT_MAX);
    });

    it('tracks limits separately per admin', async () => {
      const app = buildApp();
      for (let i = 0; i < REPLAY_RATE_LIMIT_MAX; i++) {
        await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      }

      mockAdmin = { id: 'sa-2', role: 'super_admin' };
      const res = await request(app).post('/event-replay/range').send({ startLedger: 1, endLedger: 2 });
      expect(res.status).toBe(200);
    });
  });
});

describe('createReplayRateLimiter', () => {
  it('resets the window after windowMs elapses', () => {
    let t = 0;
    const limiter = createReplayRateLimiter(1, 1000, () => t);
    const run = () => {
      let status = 200;
      const res: any = {
        setHeader: vi.fn(),
        status: (s: number) => {
          status = s;
          return { json: vi.fn() };
        },
      };
      const next = vi.fn();
      limiter({ admin: { id: 'x' } } as any, res, next);
      return next.mock.calls.length ? 200 : status;
    };

    expect(run()).toBe(200);
    expect(run()).toBe(429);
    t = 1000;
    expect(run()).toBe(200);
  });
});
