import express from 'express';
import request from 'supertest';

// Mock the database module before importing the router so the router picks up
// the mocked implementation. The webhook routes use the shared `db` client to
// query delivery and dead-letter tables.
jest.mock('../db', () => ({
  db: {
    query: jest.fn(),
  },
}));

import { db } from '../db';
import webhooksRouter from './webhooks';

const mockQuery = db.query as unknown as jest.Mock;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', webhooksRouter);
  return app;
}

/**
 * Extracts the numeric LIMIT parameter that was bound to the query, regardless
 * of whether the route used positional ($1) or named parameters.
 */
function extractLimitParam(params: unknown[]): number | undefined {
  for (const param of params) {
    if (typeof param === 'number') {
      return param;
    }
  }
  return undefined;
}

describe('webhook delivery listing endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    app = buildApp();
  });

  it('uses the default limit of 50 when no limit is provided', async () => {
    const res = await request(app).get('/webhooks/deliveries');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('falls back to the default limit of 50 for limit=0', async () => {
    const res = await request(app).get('/webhooks/deliveries?limit=0');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('rejects negative limits by falling back to the default of 50', async () => {
    const res = await request(app).get('/webhooks/deliveries?limit=-1');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('caps an oversized limit at 100', async () => {
    const res = await request(app).get('/webhooks/deliveries?limit=100000');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(100);
  });

  it('falls back to the default of 50 for a non-numeric limit', async () => {
    const res = await request(app).get('/webhooks/deliveries?limit=abc');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('passes through a valid in-range limit', async () => {
    const res = await request(app).get('/webhooks/deliveries?limit=25');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(25);
  });
});

describe('webhook dead-letter listing endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    app = buildApp();
  });

  it('uses the default limit of 50 when no limit is provided', async () => {
    const res = await request(app).get('/webhooks/dead-letters');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('falls back to the default limit of 50 for limit=0', async () => {
    const res = await request(app).get('/webhooks/dead-letters?limit=0');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('rejects negative limits by falling back to the default of 50', async () => {
    const res = await request(app).get('/webhooks/dead-letters?limit=-1');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('caps an oversized limit at 100', async () => {
    const res = await request(app).get('/webhooks/dead-letters?limit=100000');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(100);
  });

  it('falls back to the default of 50 for a non-numeric limit', async () => {
    const res = await request(app).get('/webhooks/dead-letters?limit=abc');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(50);
  });

  it('passes through a valid in-range limit', async () => {
    const res = await request(app).get('/webhooks/dead-letters?limit=25');

    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(extractLimitParam(params as unknown[])).toBe(25);
  });
});