/**
 * auditArchive route – authentication guard tests
 *
 * Verifies that GET /archive-status rejects unauthenticated requests with 401,
 * matching the authentication pattern used by every sibling route.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mock the Database and checkpoint store ──────────────────────────────────

vi.mock('../../../config/database', () => ({
  Database: {
    getAuditLogs: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../services/auditRetentionJob', () => ({
  checkpointStore: {
    load: vi.fn().mockResolvedValue(null),
  },
}));

// ─── Mock auth middleware ─────────────────────────────────────────────────────

const mockAuthenticateAdmin = vi.fn((_req: any, _res: any, next: any) => {
  next();
});

vi.mock('../../../middleware/auth', () => ({
  authenticateAdmin: (req: any, res: any, next: any) =>
    mockAuthenticateAdmin(req, res, next),
}));

// Import router after mocks
const { auditArchiveRouter } = await import('../auditArchive');

const app = express();
app.use(express.json());
app.use('/', auditArchiveRouter);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /archive-status – auth guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls authenticateAdmin middleware before the handler', async () => {
    await request(app).get('/archive-status');
    expect(mockAuthenticateAdmin).toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with 401', async () => {
    mockAuthenticateAdmin.mockImplementationOnce((_req, res, _next) => {
      return res.status(401).json({ error: 'Authentication required' });
    });

    const res = await request(app).get('/archive-status');
    expect(res.status).toBe(401);
  });

  it('allows authenticated admin requests', async () => {
    mockAuthenticateAdmin.mockImplementationOnce((_req, _res, next) => {
      next();
    });

    const res = await request(app).get('/archive-status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
