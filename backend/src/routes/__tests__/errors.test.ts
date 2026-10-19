import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import errorRoutes from '../errors';

const mockPrisma = vi.hoisted(() => ({
  errorReport: {
    create: vi.fn(),
  },
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrisma),
}));

const app = express();
app.use(express.json());
app.use('/api/errors', errorRoutes);

describe('Error Reporting Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a fully-populated error report', async () => {
    mockPrisma.errorReport.create.mockResolvedValue({ id: 'report-1' });

    const payload = {
      message: 'Cannot read properties of undefined',
      stack: 'Error: ...\n  at Component',
      componentStack: 'in Component',
      txHash: 'abc123',
      ledgerSequence: 555,
      walletAddress: 'GTEST123',
      route: '/deploy',
      network: 'testnet',
    };

    const response = await request(app).post('/api/errors').send(payload).expect(201);

    expect(response.body).toMatchObject({ success: true, data: { id: 'report-1' } });
    expect(mockPrisma.errorReport.create).toHaveBeenCalledWith({ data: payload });
  });

  it('stores a minimal report with only the required message field', async () => {
    mockPrisma.errorReport.create.mockResolvedValue({ id: 'report-2' });

    await request(app)
      .post('/api/errors')
      .send({ message: 'boom' })
      .expect(201);

    expect(mockPrisma.errorReport.create).toHaveBeenCalledWith({
      data: {
        message: 'boom',
        stack: null,
        componentStack: null,
        txHash: null,
        ledgerSequence: null,
        walletAddress: null,
        route: null,
        network: null,
      },
    });
  });

  it('accepts explicit nulls for optional fields', async () => {
    mockPrisma.errorReport.create.mockResolvedValue({ id: 'report-3' });

    await request(app)
      .post('/api/errors')
      .send({ message: 'boom', txHash: null, ledgerSequence: null, walletAddress: null, route: null, network: null })
      .expect(201);

    expect(mockPrisma.errorReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ message: 'boom', txHash: null }),
    });
  });

  it('rejects a missing message', async () => {
    const response = await request(app).post('/api/errors').send({}).expect(400);
    expect(response.body.error.details).toBeDefined();
  });

  it('rejects a non-integer ledgerSequence', async () => {
    const response = await request(app)
      .post('/api/errors')
      .send({ message: 'boom', ledgerSequence: 'not-a-number' })
      .expect(400);
    expect(response.body.error.details).toBeDefined();
  });

  it('returns 500 when the database write fails', async () => {
    mockPrisma.errorReport.create.mockRejectedValue(new Error('db down'));

    const response = await request(app)
      .post('/api/errors')
      .send({ message: 'boom' })
      .expect(500);

    expect(response.body.success).toBe(false);
  });
});
