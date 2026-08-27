import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import webhooksDeadLetterRouter from '../webhooks-deadletter';

const mockWebhookDeadLetterService = vi.hoisted(() => ({
  getEntry: vi.fn(),
  markResolved: vi.fn(),
  requeueDeadLetter: vi.fn(),
  listAllPaginated: vi.fn(),
}));

const mockWebhookService = vi.hoisted(() => ({
  getSubscription: vi.fn(),
}));

const mockWebhookDeliveryService = vi.hoisted(() => ({
  deliverWebhook: vi.fn(),
}));

const mockAuth = vi.hoisted(() => ({
  authenticateAdmin: vi.fn((req, res, next) => {
    req.user = { id: 'admin-123' };
    next();
  }),
  AuthRequest: vi.fn(),
}));

vi.mock('../../services/webhookDeadLetterService', () => ({
  default: mockWebhookDeadLetterService,
}));

vi.mock('../../services/webhookService', () => ({
  default: mockWebhookService,
}));

vi.mock('../../services/webhookDeliveryService', () => ({
  default: mockWebhookDeliveryService,
}));

vi.mock('../../middleware/auth', () => mockAuth);

vi.mock('../../middleware/auditLog', () => ({
  auditLog: () => (_req, _res, next) => next(),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks/dead-letter', webhooksDeadLetterRouter);
  return app;
}

describe('POST /api/webhooks/dead-letter/:id/requeue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully requeues a valid dead-letter entry', async () => {
    const deadLetterId = 'dl-123';
    const subscriptionId = 'sub-456';
    const mockEntry = {
      id: deadLetterId,
      subscriptionId,
      event: 'payment.completed',
      payload: JSON.stringify({ data: { amount: 100 } }),
      failureReason: 'timeout',
      attemptCount: 3,
      requeueCount: 0,
      resolvedAt: null,
    };

    const mockSubscription = {
      id: subscriptionId,
      url: 'https://webhook.example.com',
    };

    mockWebhookDeadLetterService.getEntry.mockResolvedValue(mockEntry);
    mockWebhookService.getSubscription.mockResolvedValue(mockSubscription);
    mockWebhookDeadLetterService.requeueDeadLetter.mockResolvedValue({
      ...mockEntry,
      requeueCount: 1,
    });
    mockWebhookDeliveryService.deliverWebhook.mockResolvedValue({
      success: true,
      statusCode: 200,
      attempts: 1,
      error: null,
    });

    const app = buildApp();
    const response = await request(app)
      .post(`/api/webhooks/dead-letter/${deadLetterId}/requeue`)
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      data: { id: deadLetterId },
    });
    expect(mockWebhookDeadLetterService.getEntry).toHaveBeenCalledWith(deadLetterId);
    expect(mockWebhookDeadLetterService.requeueDeadLetter).toHaveBeenCalledWith(deadLetterId);
    expect(mockWebhookDeliveryService.deliverWebhook).toHaveBeenCalledWith(
      mockSubscription,
      mockEntry.event,
      { amount: 100 },
      `requeue_${deadLetterId}`
    );
    expect(mockWebhookDeadLetterService.markResolved).toHaveBeenCalledWith(deadLetterId, 'retried');
  });

  it('leaves the entry unresolved when requeue delivery fails', async () => {
    const mockEntry = {
      id: 'dl-failed',
      subscriptionId: 'sub-456',
      event: 'payment.completed',
      payload: JSON.stringify({ data: { amount: 100 } }),
      requeueCount: 0,
      resolvedAt: null,
    };
    const mockSubscription = { id: 'sub-456', url: 'https://webhook.example.com' };
    mockWebhookDeadLetterService.getEntry.mockResolvedValue(mockEntry);
    mockWebhookDeadLetterService.requeueDeadLetter.mockResolvedValue({ ...mockEntry, requeueCount: 1 });
    mockWebhookService.getSubscription.mockResolvedValue(mockSubscription);
    mockWebhookDeliveryService.deliverWebhook.mockResolvedValue({
      success: false,
      statusCode: 503,
      attempts: 3,
      error: 'Service Unavailable',
    });

    const response = await request(buildApp())
      .post('/api/webhooks/dead-letter/dl-failed/requeue')
      .expect(502);

    expect(response.body.error.code).toBe('DELIVERY_FAILED');
    expect(mockWebhookDeadLetterService.markResolved).not.toHaveBeenCalled();
  });

  it('returns 404 when dead-letter entry not found', async () => {
    const deadLetterId = 'nonexistent-dl';
    mockWebhookDeadLetterService.getEntry.mockResolvedValue(null);

    const app = buildApp();
    const response = await request(app)
      .post(`/api/webhooks/dead-letter/${deadLetterId}/requeue`)
      .expect(404);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns 409 when requeue cap has been exceeded', async () => {
    const deadLetterId = 'dl-123';
    const subscriptionId = 'sub-456';
    const mockEntry = {
      id: deadLetterId,
      subscriptionId,
      event: 'payment.completed',
      payload: JSON.stringify({ data: { amount: 100 } }),
      failureReason: 'timeout',
      attemptCount: 3,
      requeueCount: 5,
      resolvedAt: null,
    };

    mockWebhookDeadLetterService.getEntry.mockResolvedValue(mockEntry);

    const poisonMessageError = new Error('Dead-letter entry has been requeued too many times');
    poisonMessageError.name = 'PoisonMessageError';
    mockWebhookDeadLetterService.requeueDeadLetter.mockRejectedValue(poisonMessageError);

    const app = buildApp();
    const response = await request(app)
      .post(`/api/webhooks/dead-letter/${deadLetterId}/requeue`)
      .expect(409);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'POISON_MESSAGE' },
    });
  });

  it('returns 409 when dead-letter entry has already been resolved', async () => {
    const deadLetterId = 'dl-123';
    const mockEntry = {
      id: deadLetterId,
      subscriptionId: 'sub-456',
      event: 'payment.completed',
      payload: JSON.stringify({ data: { amount: 100 } }),
      failureReason: 'timeout',
      attemptCount: 3,
      requeueCount: 0,
      resolvedAt: new Date('2024-01-01T00:00:00Z'),
      resolution: 'archived',
    };

    mockWebhookDeadLetterService.getEntry.mockResolvedValue(mockEntry);

    const app = buildApp();
    const response = await request(app)
      .post(`/api/webhooks/dead-letter/${deadLetterId}/requeue`)
      .expect(409);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'ALREADY_RESOLVED' },
    });
  });

  it('returns 500 on internal service error', async () => {
    const deadLetterId = 'dl-123';
    mockWebhookDeadLetterService.getEntry.mockRejectedValue(new Error('Database error'));

    const app = buildApp();
    const response = await request(app)
      .post(`/api/webhooks/dead-letter/${deadLetterId}/requeue`)
      .expect(500);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});
