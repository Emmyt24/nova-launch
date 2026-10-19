import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError, ErrorCode, isAppError, toAppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { errorResponse } from "../utils/response";

/**
 * Centralised error handling (#2187).
 *
 * Every error thrown from (or passed via `next(err)` by) a route handler is
 * normalised into the shared error schema defined in utils/response.ts:
 * `{ success: false, error: { code, message, details?, requestId }, requestId, timestamp }`.
 */

/** Map a framework error (body-parser, Zod, http-errors) to an AppError. */
export function normaliseError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof ZodError) {
    return new AppError({
      code: ErrorCode.VALIDATION_ERROR,
      message: "Invalid request",
      details: err.issues,
      cause: err,
    });
  }

  if (err && typeof err === "object") {
    const e = err as { type?: string; status?: unknown; statusCode?: unknown; message?: string };

    // express.json() failures carry a `type` set by body-parser
    if (e.type === "entity.parse.failed") {
      return new AppError({ code: ErrorCode.BAD_REQUEST, message: "Malformed JSON body", cause: err });
    }
    if (e.type === "entity.too.large") {
      return new AppError({ code: ErrorCode.BAD_REQUEST, message: "Request body too large", cause: err, httpStatus: 413 });
    }

    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      // Preserve the exact client status (e.g. 413) even when no dedicated code exists
      return new AppError({
        code: statusToErrorCode(status),
        message: e.message || "Bad request",
        cause: err,
        httpStatus: status,
      });
    }
  }

  return toAppError(err);
}

function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.BAD_REQUEST;
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appErr = normaliseError(err);
  const isDev = process.env.NODE_ENV === "development";

  if (appErr.httpStatus >= 500) {
    logger.error("Unhandled route error", {
      code: appErr.code,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  // Unexpected (non-AppError) 5xx messages may leak internals — hide them outside development
  const message =
    appErr.httpStatus >= 500 && !isAppError(err) && !isDev
      ? "An unexpected error occurred"
      : appErr.message;
  const exposeDetails = isDev || appErr.httpStatus < 500;

  res.status(appErr.httpStatus).json(
    errorResponse({
      code: appErr.code,
      message,
      ...(exposeDetails && appErr.details !== undefined && { details: appErr.details }),
    })
  );
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(
    errorResponse({
      code: ErrorCode.NOT_FOUND,
      message: "Route not found",
      details: { method: req.method, path: req.path },
    })
  );
}
