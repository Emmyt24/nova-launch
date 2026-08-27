/**
 * eventReplay route – authentication guard tests
 *
 * Verifies that POST /event-replay and POST /event-replay/clear-and-rebuild
 * reject unauthenticated and insufficiently-privileged requests the same way
 * every other admin route does (401 / 403 via authenticateAdmin +
 * requireSuperAdmin middleware).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mock the service so routes can be imported without real Prisma ──────────

vi.mock('../../../services/eventReplayService', () => ({
  EventReplayService: vi.fn().mockImplementation(() => ({
    replay: vi.fn().mockResolvedValue({}),
    clearAndRebuild: vi.fn().mockResolvedValue({}),
  })),
}));

// ─── Helpers to build apps with different auth configurations ─────────────────

/**
 * Returns an app where authenticateAdmin / requireSuperAdmin behave as the
 * real middleware does for the given scenario.
 */
function buildApp(authBehavior: 'no-token' | 'non-admin' | 'super-admin') {
  vi.doMock('../../../middleware/auth', () => {
    const authenticateAdmin = (req: any, res: any, next: any) => {
      if (authBehavior === 'no-token') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (authBehavior === 'non-admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      // super-admin: attach a user and continue
      req.admin = { id: 'sa-1', role: 'super_admin', banned: false };
      next();
    };

    const requireSuperAdmin = (req: any, res: any, next: any) => {
      if (!req.admin || req.admin.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
      }
      next();
    };

    return { authenticateAdmin, requireSuperAdmin };
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /event-replay – auth guards', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects requests with no token with 401', async () => {
    buildApp('no-token');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app).post('/event-replay');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    buildApp('non-admin');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app)
      .post('/event-replay')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
  });

  it('accepts super_admin requests', async () => {
    buildApp('super-admin');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app)
      .post('/event-replay')
      .set('Authorization', 'Bearer super-admin-token');
    expect(res.status).toBe(200);
  });
});

describe('POST /event-replay/clear-and-rebuild – auth guards', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects requests with no token with 401', async () => {
    buildApp('no-token');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app).post('/event-replay/clear-and-rebuild');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    buildApp('non-admin');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app)
      .post('/event-replay/clear-and-rebuild')
      .set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(403);
  });

  it('requires ?confirm=yes even for super_admin', async () => {
    buildApp('super-admin');
    const { default: router } = await import('../eventReplay');
    const app = express();
    app.use(express.json());
    app.use('/', router);

    const res = await request(app)
      .post('/event-replay/clear-and-rebuild')
      .set('Authorization', 'Bearer super-admin-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Cc]onfirmation/);
  });
});
