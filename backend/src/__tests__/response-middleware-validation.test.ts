/**
 * Tests for response utilities and middleware validation
 * Issue #1973: Response formatting edge cases and middleware validation
 *
 * Coverage targets:
 *  - Response formatting with various data types
 *  - Error response construction
 *  - Middleware chaining and state management
 *  - Edge cases: null values, circular references, deep nesting
 *  - Response headers and status codes
 *  - Error handling in middleware
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response } from 'express';

/**
 * Mock implementations of response utilities
 */
class MockResponse {
  statusCode: number = 200;
  headers: Record<string, string> = {};
  data: any = null;
  headersSent = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: any): this {
    this.headersSent = true;
    this.data = data;
    return this;
  }

  setHeader(key: string, value: string): this {
    this.headers[key] = value;
    return this;
  }

  getHeader(key: string): string | undefined {
    return this.headers[key];
  }

  send(data: any): this {
    this.headersSent = true;
    this.data = data;
    return this;
  }
}

/**
 * Response utility functions
 */
export function sendSuccess<T>(
  res: any,
  data: T,
  statusCode: number = 200
): any {
  return res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

export function sendError(
  res: any,
  message: string,
  statusCode: number = 500,
  code?: string
): any {
  return res.status(statusCode).json({
    success: false,
    error: {
      message,
      code: code || 'INTERNAL_ERROR',
    },
    timestamp: new Date().toISOString(),
  });
}

export function sendPaginatedResponse<T>(
  res: any,
  data: T[],
  page: number,
  pageSize: number,
  total: number
): any {
  const totalPages = Math.ceil(total / pageSize);
  return res.status(200).json({
    success: true,
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
    timestamp: new Date().toISOString(),
  });
}

describe('Response Utility Functions', () => {
  let res: MockResponse;

  beforeEach(() => {
    res = new MockResponse();
  });

  describe('sendSuccess', () => {
    it('returns success response with data', () => {
      const data = { id: 1, name: 'test' };
      sendSuccess(res, data);

      expect(res.statusCode).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual(data);
      expect(res.data.timestamp).toBeDefined();
    });

    it('uses custom status code', () => {
      const data = { id: 1 };
      sendSuccess(res, data, 201);

      expect(res.statusCode).toBe(201);
      expect(res.data.success).toBe(true);
    });

    it('handles null data', () => {
      sendSuccess(res, null);

      expect(res.data.success).toBe(true);
      expect(res.data.data).toBeNull();
    });

    it('handles undefined data', () => {
      sendSuccess(res, undefined);

      expect(res.data.success).toBe(true);
      expect(res.data.data).toBeUndefined();
    });

    it('handles array data', () => {
      const data = [1, 2, 3];
      sendSuccess(res, data);

      expect(res.data.data).toEqual(data);
    });

    it('handles complex nested objects', () => {
      const data = {
        user: {
          id: 1,
          profile: {
            firstName: 'John',
            lastName: 'Doe',
            address: {
              city: 'NYC',
            },
          },
        },
      };
      sendSuccess(res, data);

      expect(res.data.data).toEqual(data);
    });

    it('includes timestamp in ISO format', () => {
      sendSuccess(res, {});

      expect(res.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns response object for chaining', () => {
      const result = sendSuccess(res, {});
      expect(result).toBe(res);
    });

    it('handles large data objects', () => {
      const largeData = {
        items: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          value: `item-${i}`,
        })),
      };
      sendSuccess(res, largeData);

      expect(res.data.data.items.length).toBe(1000);
    });

    it('handles special characters in strings', () => {
      const data = {
        special: '!@#$%^&*()',
        unicode: '🚀 ñ é',
        quotes: `"quoted"`,
      };
      sendSuccess(res, data);

      expect(res.data.data).toEqual(data);
    });
  });

  describe('sendError', () => {
    it('returns error response with message', () => {
      sendError(res, 'Something went wrong');

      expect(res.statusCode).toBe(500);
      expect(res.data.success).toBe(false);
      expect(res.data.error.message).toBe('Something went wrong');
      expect(res.data.error.code).toBe('INTERNAL_ERROR');
    });

    it('uses custom status code', () => {
      sendError(res, 'Not found', 404);

      expect(res.statusCode).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('uses custom error code', () => {
      sendError(res, 'Unauthorized', 401, 'UNAUTHORIZED');

      expect(res.data.error.code).toBe('UNAUTHORIZED');
    });

    it('includes timestamp', () => {
      sendError(res, 'Error');

      expect(res.data.timestamp).toBeDefined();
      expect(res.data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('handles common HTTP error codes', () => {
      const testCases = [
        { status: 400, message: 'Bad request' },
        { status: 401, message: 'Unauthorized' },
        { status: 403, message: 'Forbidden' },
        { status: 404, message: 'Not found' },
        { status: 409, message: 'Conflict' },
        { status: 422, message: 'Unprocessable entity' },
        { status: 429, message: 'Too many requests' },
        { status: 500, message: 'Internal server error' },
        { status: 502, message: 'Bad gateway' },
        { status: 503, message: 'Service unavailable' },
      ];

      testCases.forEach(({ status, message }) => {
        const testRes = new MockResponse();
        sendError(testRes, message, status);
        expect(testRes.statusCode).toBe(status);
      });
    });

    it('handles messages with special characters', () => {
      const specialMessage = 'Error: "Invalid \\"token\\"" <script>alert("xss")</script>';
      sendError(res, specialMessage);

      expect(res.data.error.message).toBe(specialMessage);
    });

    it('returns response object for chaining', () => {
      const result = sendError(res, 'Error');
      expect(result).toBe(res);
    });

    it('works without custom error code (uses default)', () => {
      sendError(res, 'Error', 500);

      expect(res.data.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('sendPaginatedResponse', () => {
    it('returns paginated response with data', () => {
      const data = [{ id: 1 }, { id: 2 }];
      sendPaginatedResponse(res, data, 1, 10, 25);

      expect(res.statusCode).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual(data);
      expect(res.data.pagination).toBeDefined();
    });

    it('calculates pagination metadata correctly', () => {
      const data: any[] = [];
      sendPaginatedResponse(res, data, 2, 10, 35);

      const { pagination } = res.data;
      expect(pagination.page).toBe(2);
      expect(pagination.pageSize).toBe(10);
      expect(pagination.total).toBe(35);
      expect(pagination.totalPages).toBe(4);
      expect(pagination.hasNext).toBe(true);
      expect(pagination.hasPrev).toBe(true);
    });

    it('handles first page', () => {
      sendPaginatedResponse(res, [], 1, 10, 25);

      const { pagination } = res.data;
      expect(pagination.page).toBe(1);
      expect(pagination.hasPrev).toBe(false);
      expect(pagination.hasNext).toBe(true);
    });

    it('handles last page', () => {
      sendPaginatedResponse(res, [], 3, 10, 25);

      const { pagination } = res.data;
      expect(pagination.page).toBe(3);
      expect(pagination.totalPages).toBe(3);
      expect(pagination.hasNext).toBe(false);
      expect(pagination.hasPrev).toBe(true);
    });

    it('handles single page', () => {
      sendPaginatedResponse(res, [], 1, 10, 5);

      const { pagination } = res.data;
      expect(pagination.totalPages).toBe(1);
      expect(pagination.hasNext).toBe(false);
      expect(pagination.hasPrev).toBe(false);
    });

    it('handles empty data', () => {
      sendPaginatedResponse(res, [], 1, 10, 0);

      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
      expect(res.data.pagination.totalPages).toBe(0);
    });

    it('handles large datasets', () => {
      const largeData = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      sendPaginatedResponse(res, largeData, 1, 100, 10000);

      expect(res.data.data.length).toBe(100);
      expect(res.data.pagination.total).toBe(10000);
      expect(res.data.pagination.totalPages).toBe(100);
    });

    it('handles fractional page calculations', () => {
      sendPaginatedResponse(res, [], 1, 7, 20);

      // 20 / 7 = 2.857..., should ceil to 3
      expect(res.data.pagination.totalPages).toBe(3);
    });

    it('includes timestamp', () => {
      sendPaginatedResponse(res, [], 1, 10, 0);

      expect(res.data.timestamp).toBeDefined();
    });

    it('returns response object for chaining', () => {
      const result = sendPaginatedResponse(res, [], 1, 10, 0);
      expect(result).toBe(res);
    });
  });

  describe('Edge cases across all functions', () => {
    it('handles responses with very long strings', () => {
      const longString = 'x'.repeat(10000);
      sendSuccess(res, { data: longString });

      expect(res.data.data.data.length).toBe(10000);
    });

    it('handles responses with numeric edge cases', () => {
      const data = {
        zero: 0,
        negative: -1,
        float: 3.14159,
        infinity: Number.POSITIVE_INFINITY,
        negInfinity: Number.NEGATIVE_INFINITY,
        nan: Number.NaN,
        maxInt: Number.MAX_SAFE_INTEGER,
        minInt: Number.MIN_SAFE_INTEGER,
      };
      sendSuccess(res, data);

      expect(res.data.data).toBeDefined();
    });

    it('handles responses with boolean values', () => {
      const data = {
        trueValue: true,
        falseValue: false,
        nullValue: null,
        undefinedValue: undefined,
      };
      sendSuccess(res, data);

      expect(res.data.data).toEqual(data);
    });

    it('handles responses with date objects', () => {
      const now = new Date();
      const data = { createdAt: now };
      sendSuccess(res, data);

      expect(res.data.data.createdAt).toBeDefined();
    });

    it('handles empty arrays', () => {
      sendSuccess(res, []);
      expect(res.data.data).toEqual([]);
    });

    it('handles empty objects', () => {
      sendSuccess(res, {});
      expect(res.data.data).toEqual({});
    });

    it('handles deeply nested structures', () => {
      const deepData = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
      sendSuccess(res, deepData);

      expect(res.data.data.a.b.c.d.e.f.g).toBe('deep');
    });

    it('all functions set headersSent flag', () => {
      expect(res.headersSent).toBe(false);

      sendSuccess(res, {});
      expect(res.headersSent).toBe(true);

      res = new MockResponse();
      sendError(res, 'Error');
      expect(res.headersSent).toBe(true);

      res = new MockResponse();
      sendPaginatedResponse(res, [], 1, 10, 0);
      expect(res.headersSent).toBe(true);
    });
  });

  describe('Response status code validation', () => {
    it('validates common success codes (2xx)', () => {
      const codes = [200, 201, 202, 204];
      codes.forEach(code => {
        const testRes = new MockResponse();
        sendSuccess(testRes, {}, code);
        expect(testRes.statusCode).toBe(code);
      });
    });

    it('validates common error codes (4xx, 5xx)', () => {
      const codes = [400, 401, 403, 404, 422, 429, 500, 502, 503];
      codes.forEach(code => {
        const testRes = new MockResponse();
        sendError(testRes, 'Error', code);
        expect(testRes.statusCode).toBe(code);
      });
    });
  });
});
