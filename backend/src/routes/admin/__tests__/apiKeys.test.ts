import express from 'express';
import request from 'supertest';
import { createApiKey } from '../../../services/apiKeyService';
import adminApiKeysRouter from '../apiKeys';

jest.mock('../../../services/apiKeyService', () => ({
  createApiKey: jest.fn(),
}));

const mockedCreateApiKey = createApiKey as jest.MockedFunction<typeof createApiKey>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/api-keys', adminApiKeysRouter);
  return app;
}

describe('POST /admin/api-keys', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the validation message for a known validation error', async () => {
    const validationError = new Error('Name is required');
    validationError.name = 'ValidationError';
    mockedCreateApiKey.mockRejectedValueOnce(validationError);

    const res = await request(buildApp())
      .post('/admin/api-keys')
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Name is required' });
  });

  it('returns a generic message and logs details for an unexpected error type', async () => {
    const unexpectedError = new Error('boom: sk_live_secret_key_material');
    unexpectedError.name = 'TypeError';
    mockedCreateApiKey.mockRejectedValueOnce(unexpectedError);

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(buildApp())
      .post('/admin/api-keys')
      .send({ name: 'my-key' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create API key' });
    expect(JSON.stringify(res.body)).not.toContain('sk_live_secret_key_material');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
