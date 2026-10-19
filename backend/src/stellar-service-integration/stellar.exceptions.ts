import { StellarErrorCode } from "./stellar.types";

export enum HttpStatus {
  BAD_REQUEST = 400,
  NOT_FOUND = 404,
  TOO_MANY_REQUESTS = 429,
  BAD_GATEWAY = 502,
  GATEWAY_TIMEOUT = 504,
  INTERNAL_SERVER_ERROR = 500,
}

export class HttpException extends Error {
  constructor(
    public readonly response: unknown,
    public readonly status: HttpStatus
  ) {
    super(typeof response === "string" ? response : "HttpException");
    this.name = "HttpException";
  }
}

export class StellarException extends HttpException {
  public readonly code: StellarErrorCode;
  public readonly details?: unknown;

  constructor(
    code: StellarErrorCode,
    message: string,
    details?: unknown,
    status: HttpStatus = HttpStatus.BAD_GATEWAY
  ) {
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}

export class StellarNetworkException extends StellarException {
  constructor(message: string, details?: unknown) {
    super(StellarErrorCode.NETWORK_ERROR, message, details);
  }
}

export class StellarEndpointUnavailableException extends StellarException {
  constructor(network: string, details?: unknown) {
    super(
      StellarErrorCode.ENDPOINT_UNAVAILABLE,
      `No healthy RPC endpoint available for network: ${network}`,
      { network, ...(typeof details === "object" && details !== null ? details : {}) },
      HttpStatus.BAD_GATEWAY
    );
  }
}

export class StellarInvalidAddressException extends StellarException {
  constructor(address: string) {
    super(
      StellarErrorCode.INVALID_ADDRESS,
      `Invalid Stellar address: ${address}`,
      { address },
      HttpStatus.BAD_REQUEST
    );
  }
}

export class StellarContractException extends StellarException {
  constructor(message: string, details?: unknown) {
    super(StellarErrorCode.CONTRACT_ERROR, message, details);
  }
}

export class StellarTransactionFailedException extends StellarException {
  constructor(txHash: string, details?: unknown) {
    super(
      StellarErrorCode.TRANSACTION_FAILED,
      `Transaction failed: ${txHash}`,
      details
    );
  }
}

export class StellarRateLimitException extends StellarException {
  constructor() {
    super(
      StellarErrorCode.RATE_LIMITED,
      "Rate limit exceeded. Please try again later.",
      undefined,
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

export class StellarTimeoutException extends StellarException {
  constructor(operation: string) {
    super(
      StellarErrorCode.TIMEOUT,
      `Operation timed out: ${operation}`,
      undefined,
      HttpStatus.GATEWAY_TIMEOUT
    );
  }
}

export class StellarNotFoundException extends StellarException {
  constructor(resource: string, identifier: string) {
    super(
      StellarErrorCode.NOT_FOUND,
      `${resource} not found: ${identifier}`,
      { resource, identifier },
      HttpStatus.NOT_FOUND
    );
  }
}

export class StellarParseException extends StellarException {
  constructor(message: string, details?: unknown) {
    super(
      StellarErrorCode.PARSE_ERROR,
      `Parse error: ${message}`,
      details,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
}

export class StellarSequenceMismatchException extends StellarException {
  constructor(accountId: string, details?: unknown) {
    super(
      StellarErrorCode.TRANSACTION_FAILED,
      `Sequence number mismatch for account: ${accountId}`,
      details,
      HttpStatus.BAD_REQUEST
    );
  }
}
