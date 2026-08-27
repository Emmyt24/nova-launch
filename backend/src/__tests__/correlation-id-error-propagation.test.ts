/**
 * Tests for #1591: Correlation ID propagation in error response bodies.
 *
 * Verifies that every error response (4xx/5xx) includes the request's correlation ID
 * in the JSON body, making it easy for callers to reference a specific failed request
 * when reporting issues.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { CorrelationLogger } from '../middleware/correlation-logging';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(CorrelationLogger.middleware());

  // Test route that validates required field
  app.post('/api/test/required', (req, res) => {
    if (!req.body.name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name is required',
          correlationId: req.correlationId,
        },
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      });
    }
    res.json({ success: true, data: { name: req.body.name } });
  });

  // Test route that simulates internal error
  app.post('/api/test/error', (req, res) => {
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong',
        correlationId: req.correlationId,
      },
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId,
    });
  });

  // Test route that returns 404
  app.get('/api/test/notfound', (req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        correlationId: req.correlationId,
      },
      timestamp: new Date().toISOString(),
      correlationId: req.correlationId,
    });
  });

  return app;
}

describe('Correlation ID in error responses', () => {
  it('includes correlation ID in 400 error response body', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/test/required')
      .send({})
      .expect(400);

    expect(response.body).toHaveProperty('correlationId');
    expect(response.body).toHaveProperty('error.correlationId');
    expect(response.body.correlationId).toBeDefined();
    expect(response.body.error.correlationId).toBe(response.body.correlationId);
    expect(typeof response.body.correlationId).toBe('string');
    expect(response.body.correlationId.length).toBeGreaterThan(0);
  });

  it('includes correlation ID in 500 error response body', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/test/error')
      .expect(500);

    expect(response.body).toHaveProperty('correlationId');
    expect(response.body).toHaveProperty('error.correlationId');
    expect(response.body.correlationId).toBeDefined();
    expect(response.body.error.correlationId).toBe(response.body.correlationId);
  });

  it('includes correlation ID in 404 error response body', async () => {
    const app = buildApp();
    const response = await request(app)
      .get('/api/test/notfound')
      .expect(404);

    expect(response.body).toHaveProperty('correlationId');
    expect(response.body).toHaveProperty('error.correlationId');
    expect(response.body.correlationId).toBeDefined();
    expect(response.body.error.correlationId).toBe(response.body.correlationId);
  });

  it('propagates provided x-correlation-id header to error response', async () => {
    const app = buildApp();
    const customCorrelationId = 'custom-correlation-id-123';
    const response = await request(app)
      .post('/api/test/required')
      .set('x-correlation-id', customCorrelationId)
      .send({})
      .expect(400);

    expect(response.body.correlationId).toBe(customCorrelationId);
    expect(response.body.error.correlationId).toBe(customCorrelationId);
  });

  it('generates and propagates correlation ID when none provided', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/api/test/required')
      .send({})
      .expect(400);

    expect(response.body.correlationId).toBeDefined();
    expect(response.body.error.correlationId).toBe(response.body.correlationId);
    // UUID v4 format check (basic)
    expect(response.body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('includes response header and body correlation ID match', async () => {
    const app = buildApp();
    const customId = 'header-body-match-test';
    const response = await request(app)
      .post('/api/test/error')
      .set('x-correlation-id', customId)
      .expect(500);

    expect(response.headers['x-correlation-id']).toBe(customId);
    expect(response.body.correlationId).toBe(customId);
    expect(response.body.error.correlationId).toBe(customId);
  });
});
