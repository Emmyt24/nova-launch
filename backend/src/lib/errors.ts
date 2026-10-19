/**
 * Comprehensive error handling framework for Nova Launch backend.
 *
 * Provides:
 *  - Typed error codes covering all domain areas (validation, auth, Stellar, DB, etc.)
 *  - AppError base class with HTTP status mapping
 *  - Domain-specific subclasses for precise error semantics
 *  - toHttpResponse() helper for consistent Express error responses
 *  - isAppError() type-guard for safe narrowing in catch blocks
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export enum ErrorCode {
  // Generic
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  NOT_FOUND = "NOT_FOUND",
  BAD_REQUEST = "BAD_REQUEST",
  CONFLICT = "CONFLICT",

  // Auth / access
  UNAUTHORIZED = "UNAUTHORIZED",
  FORBIDDEN = "FORBIDDEN",
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  RATE_LIMITED = "RATE_LIMITED",

  // Validation
  VALIDATION_ERROR = "VALIDATION_ERROR",
  INVALID_ADDRESS = "INVALID_ADDRESS",
  INVALID_AMOUNT = "INVALID_AMOUNT",
  INVALID_PARAMETERS = "INVALID_PARAMETERS",

  // Stellar / blockchain
  STELLAR_NETWORK_ERROR = "STELLAR_NETWORK_ERROR",
  STELLAR_TRANSACTION_FAILED = "STELLAR_TRANSACTION_FAILED",
  STELLAR_CONTRACT_ERROR = "STELLAR_CONTRACT_ERROR",
  STELLAR_INSUFFICIENT_FEE = "STELLAR_INSUFFICIENT_FEE",
  STELLAR_ACCOUNT_NOT_FOUND = "STELLAR_ACCOUNT_NOT_FOUND",
  STELLAR_TIMEOUT = "STELLAR_TIMEOUT",
  STELLAR_SIMULATION_FAILED = "STELLAR_SIMULATION_FAILED",

  // Database
  DATABASE_ERROR = "DATABASE_ERROR",
  DATABASE_CONNECTION_ERROR = "DATABASE_CONNECTION_ERROR",
  RECORD_NOT_FOUND = "RECORD_NOT_FOUND",
  DUPLICATE_RECORD = "DUPLICATE_RECORD",

  // External services
  IPFS_ERROR = "IPFS_ERROR",
  WEBHOOK_DELIVERY_FAILED = "WEBHOOK_DELIVERY_FAILED",
  EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
  CIRCUIT_BREAKER_OPEN = "CIRCUIT_BREAKER_OPEN",
}

// ---------------------------------------------------------------------------
// HTTP status mapping
// ---------------------------------------------------------------------------

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.INTERNAL_SERVER_ERROR]: 500,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.CONFLICT]: 409,

  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.INVALID_TOKEN]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.RATE_LIMITED]: 429,

  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.INVALID_ADDRESS]: 422,
  [ErrorCode.INVALID_AMOUNT]: 422,
  [ErrorCode.INVALID_PARAMETERS]: 422,

  [ErrorCode.STELLAR_NETWORK_ERROR]: 502,
  [ErrorCode.STELLAR_TRANSACTION_FAILED]: 502,
  [ErrorCode.STELLAR_CONTRACT_ERROR]: 502,
  [ErrorCode.STELLAR_INSUFFICIENT_FEE]: 402,
  [ErrorCode.STELLAR_ACCOUNT_NOT_FOUND]: 404,
  [ErrorCode.STELLAR_TIMEOUT]: 504,
  [ErrorCode.STELLAR_SIMULATION_FAILED]: 422,

  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.DATABASE_CONNECTION_ERROR]: 503,
  [ErrorCode.RECORD_NOT_FOUND]: 404,
  [ErrorCode.DUPLICATE_RECORD]: 409,

  [ErrorCode.IPFS_ERROR]: 502,
  [ErrorCode.WEBHOOK_DELIVERY_FAILED]: 502,
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 502,
  [ErrorCode.CIRCUIT_BREAKER_OPEN]: 503,
};

// ---------------------------------------------------------------------------
// Base error class
// ---------------------------------------------------------------------------

export interface AppErrorOptions {
  /** Machine-readable error code */
  code: ErrorCode;
  /** Human-readable message (safe to surface to clients) */
  message: string;
  /** Optional structured details (omitted in production for 5xx errors) */
  details?: unknown;
  /** Original cause – kept server-side only */
  cause?: unknown;
  /** Override the status derived from `code` (e.g. 413 for an oversized body) */
  httpStatus?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly cause?: unknown;

  constructor({ code, message, details, cause, httpStatus }: AppErrorOptions) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus ?? ERROR_HTTP_STATUS[code];
    this.details = details;
    this.cause = cause;

    // Maintain proper prototype chain in transpiled ES5
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialise to a client-safe HTTP response body.
   * Stack traces and cause are never included.
   * Details are stripped for 5xx errors outside development.
   */
  toHttpResponse(isDev = false): {
    success: false;
    error: { code: string; message: string; details?: unknown };
    timestamp: string;
  } {
    const exposeDetails = isDev || this.httpStatus < 500;
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(exposeDetails && this.details !== undefined
          ? { details: this.details }
          : {}),
      },
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Domain-specific subclasses
// ---------------------------------------------------------------------------

/** 400 – generic bad request */
export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super({ code: ErrorCode.BAD_REQUEST, message, details });
    this.name = "BadRequestError";
  }
}

/** 404 – generic not found */
export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    const message = identifier
      ? `${resource} not found: ${identifier}`
      : `${resource} not found`;
    super({ code: ErrorCode.NOT_FOUND, message, details: { resource, identifier } });
    this.name = "NotFoundError";
  }
}

/** 409 – conflict / duplicate */
export class ConflictError extends AppError {
  constructor(message = "Resource already exists", details?: unknown) {
    super({ code: ErrorCode.CONFLICT, message, details });
    this.name = "ConflictError";
  }
}

/** 401 – unauthenticated */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super({ code: ErrorCode.UNAUTHORIZED, message });
    this.name = "UnauthorizedError";
  }
}

/** 403 – authenticated but not permitted */
export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super({ code: ErrorCode.FORBIDDEN, message });
    this.name = "ForbiddenError";
  }
}

/** 401 – JWT invalid */
export class InvalidTokenError extends AppError {
  constructor(message = "Invalid token") {
    super({ code: ErrorCode.INVALID_TOKEN, message });
    this.name = "InvalidTokenError";
  }
}

/** 401 – JWT expired */
export class TokenExpiredError extends AppError {
  constructor(message = "Token has expired") {
    super({ code: ErrorCode.TOKEN_EXPIRED, message });
    this.name = "TokenExpiredError";
  }
}

/** 429 – rate limit hit */
export class RateLimitError extends AppError {
  constructor(message = "Too many requests, please try again later") {
    super({ code: ErrorCode.RATE_LIMITED, message });
    this.name = "RateLimitError";
  }
}

/** 422 – input validation failure */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: ErrorCode.VALIDATION_ERROR, message, details });
    this.name = "ValidationError";
  }
}

/** 422 – invalid Stellar address */
export class InvalidAddressError extends AppError {
  constructor(address: string) {
    super({
      code: ErrorCode.INVALID_ADDRESS,
      message: `Invalid Stellar address: ${address}`,
      details: { address },
    });
    this.name = "InvalidAddressError";
  }
}

/** 422 – invalid numeric amount */
export class InvalidAmountError extends AppError {
  constructor(amount: unknown) {
    super({
      code: ErrorCode.INVALID_AMOUNT,
      message: `Invalid amount: ${amount}`,
      details: { amount },
    });
    this.name = "InvalidAmountError";
  }
}

/** 502 – Stellar network unreachable */
export class StellarNetworkError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCode.STELLAR_NETWORK_ERROR, message, cause });
    this.name = "StellarNetworkError";
  }
}

/** 502 – on-chain transaction failed */
export class StellarTransactionError extends AppError {
  constructor(txHash: string, details?: unknown) {
    super({
      code: ErrorCode.STELLAR_TRANSACTION_FAILED,
      message: `Transaction failed: ${txHash}`,
      details,
    });
    this.name = "StellarTransactionError";
  }
}

/** 502 – smart contract execution error */
export class StellarContractError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: ErrorCode.STELLAR_CONTRACT_ERROR, message, details });
    this.name = "StellarContractError";
  }
}

/** 402 – fee below minimum */
export class StellarInsufficientFeeError extends AppError {
  constructor(required: number, provided: number) {
    super({
      code: ErrorCode.STELLAR_INSUFFICIENT_FEE,
      message: `Insufficient fee: required ${required}, provided ${provided}`,
      details: { required, provided },
    });
    this.name = "StellarInsufficientFeeError";
  }
}

/** 504 – Stellar operation timed out */
export class StellarTimeoutError extends AppError {
  constructor(operation: string) {
    super({
      code: ErrorCode.STELLAR_TIMEOUT,
      message: `Stellar operation timed out: ${operation}`,
      details: { operation },
    });
    this.name = "StellarTimeoutError";
  }
}

/** 500 – generic database error */
export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCode.DATABASE_ERROR, message, cause });
    this.name = "DatabaseError";
  }
}

/** 503 – cannot reach database */
export class DatabaseConnectionError extends AppError {
  constructor(cause?: unknown) {
    super({
      code: ErrorCode.DATABASE_CONNECTION_ERROR,
      message: "Database connection unavailable",
      cause,
    });
    this.name = "DatabaseConnectionError";
  }
}

/** 409 – unique constraint violation */
export class DuplicateRecordError extends AppError {
  constructor(resource: string, field?: string) {
    super({
      code: ErrorCode.DUPLICATE_RECORD,
      message: field
        ? `${resource} with this ${field} already exists`
        : `${resource} already exists`,
      details: { resource, field },
    });
    this.name = "DuplicateRecordError";
  }
}

/** 502 – IPFS upload / fetch failure */
export class IpfsError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: ErrorCode.IPFS_ERROR, message, cause });
    this.name = "IpfsError";
  }
}

/** 502 – webhook could not be delivered */
export class WebhookDeliveryError extends AppError {
  constructor(url: string, cause?: unknown) {
    super({
      code: ErrorCode.WEBHOOK_DELIVERY_FAILED,
      message: `Webhook delivery failed to ${url}`,
      details: { url },
      cause,
    });
    this.name = "WebhookDeliveryError";
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Type-guard: narrows `unknown` to `AppError`. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Normalise any thrown value into an AppError.
 * Unknown errors become INTERNAL_SERVER_ERROR so callers always get a typed result.
 */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (err instanceof Error) {
    return new AppError({
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: err.message,
      cause: err,
    });
  }

  return new AppError({
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    message: typeof err === "string" ? err : "An unexpected error occurred",
    cause: err,
  });
}
