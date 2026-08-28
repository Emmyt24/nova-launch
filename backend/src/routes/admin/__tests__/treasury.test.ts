import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const integrationState = new Map<string, string>();

vi.mock('../../../middleware/auth', () => ({
  authenticateAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    integrationState: {
      findUnique: vi.fn(({ where }: { where: { key: string } }) => {
        const value = integrationState.get(where.key);
        return Promise.resolve(value ? { key: where.key, value } : null);
      }),
      upsert: vi.fn(({ create, update, where }: { create: { key: string; value: string }; update: { value: string }; where: { key: string } }) => {
        integrationState.set(where.key, update.value ?? create.value);
        return Promise.resolve({ key: where.key, value: update.value ?? create.value });
      }),
    },
  },
}));

const { default: treasuryRouter } = await import('../treasury');

const app = express();
app.use(express.json());
app.use('/', treasuryRouter);

beforeEach(() => {
  integrationState.clear();
});

describe('GET /api/admin/treasury/policy', () => {
  it('returns current treasury policy', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.dailyCap).toBe('string');
    expect(/^\d+$/.test(res.body.data.dailyCap)).toBe(true);
  });
});

describe('PUT /api/admin/treasury/policy', () => {
  it('updates dailyCap with valid string integer', async () => {
    const res = await request(app)
      .put('/')
      .send({ dailyCap: '5000000000' });
    expect(res.status).toBe(200);
    expect(res.body.data.dailyCap).toBe('5000000000');

    const freshApp = express();
    freshApp.use(express.json());
    const { default: freshTreasuryRouter } = await import('../treasury');
    freshApp.use('/', freshTreasuryRouter);
    const persisted = await request(freshApp).get('/');
    expect(persisted.body.data.dailyCap).toBe('5000000000');
  });

  it('rejects non-string dailyCap', async () => {
    const res = await request(app)
      .put('/')
      .send({ dailyCap: 5000000000 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects non-numeric string dailyCap', async () => {
    const res = await request(app)
      .put('/')
      .send({ dailyCap: 'bad-value' });
    expect(res.status).toBe(400);
  });
});
