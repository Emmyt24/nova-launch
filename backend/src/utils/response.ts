import type { Response } from "express";
import {
  getCorrelationId,
  getRequestId,
  getTransactionId,
} from "../lib/async-context";

/**
 * Shared error schema returned by every route (#2187).
 *
 *   {
 *     "success": false,
 *     "error": { "code": "NOT_FOUND", "message": "...", "details": {...}, "requestId": "..." },
 *     "requestId": "...",
 *     "timestamp": "..."
 *   }
 *
 * `code` is a stable, machine-readable identifier (see `ErrorCode` in
 * lib/errors.ts), `message` is safe to show to end users, `details` is
 * optional structured context, and `requestId` matches the `X-Request-Id`
 * response header so clients can quote it in support requests.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: any;
  requestId?: string;
  correlationId?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiErrorBody;
  timestamp: string;
  requestId?: string;
  correlationId?: string;
  transactionId?: string;
}

export function successResponse<T>(data: T, correlationId?: string): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    ...(correlationId && { correlationId }),
  };
}

/**
 * Build a structured error body. The request, correlation and transaction
 * IDs are filled in from the async request context when not passed explicitly.
 */
export function errorResponse(
  error: {
    code: string;
    message: string;
    details?: any;
  },
  correlationId?: string
): ApiResponse<null> {
  const requestId = getRequestId();
  const cid = correlationId ?? getCorrelationId();
  const transactionId = getTransactionId();

  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
      ...(requestId && { requestId }),
      ...(cid && { correlationId: cid }),
    },
    timestamp: new Date().toISOString(),
    ...(requestId && { requestId }),
    ...(cid && { correlationId: cid }),
    ...(transactionId && { transactionId }),
  };
}

/**
 * Send a structured error response. Prefer this over hand-built
 * `res.status(...).json({ error: ... })` bodies in route handlers.
 */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
): Response {
  return res.status(status).json(errorResponse({ code, message, details }));
}
