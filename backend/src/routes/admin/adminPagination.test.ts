import express from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { id: 'admin-1', role: 'admin' };
    next();
  },
}));

jest.mock('../../db', () => ({
  __esModule: true,
  default: {
    auditLog: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    token: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import db from '../../db';
import auditRouter from './audit';
import tokensRouter from './tokens';

const DEFAULT_AUDIT_PAGE_SIZE = 50;
const DEFAULT_LIMIT = 20;

const buildApp = (router: express.Router) => {
  const app = express();
  app.use(express.json());
  app.use('/admin', router);
  return app;
};

describe('admin audit log query parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.auditLog.findMany as jest.Mock).mockResolvedValue([]);
    (db.auditLog.count as jest.Mock).mockResolvedValue(0);
  });

  it('falls back to defaults for malformed limit and page values', async () => {
    const app = buildApp(auditRouter);

    const res = await request(app).get('/admin/audit?limit=abc&page=-1');

    expect(res.status).toBe(200);
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: DEFAULT_AUDIT_PAGE_SIZE,
        skip: 0,
      }),
    );
  });

  it('uses parsed values for valid numeric filters', async () => {
    const app = buildApp(auditRouter);

    const res = await request(app).get('/admin/audit?limit=10&page=2');

    expect(res.status).toBe(200);
    expect(db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        skip: 10,
      }),
    );
  });
});

describe('admin token listing query parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.token.findMany as jest.Mock).mockResolvedValue([]);
    (db.token.count as jest.Mock).mockResolvedValue(0);
  });

  it('falls back to DEFAULT_LIMIT for a non-numeric limit', async () => {
    const app = buildApp(tokensRouter);

    const res = await request(app).get('/admin/tokens?limit=abc');

    expect(res.status).toBe(200);
    expect(db.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: DEFAULT_LIMIT,
      }),
    );
  });

  it('falls back to 0 for a non-numeric offset', async () => {
    const app = buildApp(tokensRouter);

    const res = await request(app).get('/admin/tokens?offset=abc');

    expect(res.status).toBe(200);
    expect(db.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
      }),
    );
  });

  it('clamps negative limit and offset to 0', async () => {
    const app = buildApp(tokensRouter);

    const res = await request(app).get('/admin/tokens?limit=-5&offset=-10');

    expect(res.status).toBe(200);
    expect(db.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 0,
        skip: 0,
      }),
    );
  });

  it('uses parsed values for valid numeric filters', async () => {
    const app = buildApp(tokensRouter);

    const res = await request(app).get('/admin/tokens?limit=5&offset=10');

    expect(res.status).toBe(200);
    expect(db.token.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
        skip: 10,
      }),
    );
  });
});