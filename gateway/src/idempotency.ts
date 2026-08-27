import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createIdempotencyMiddleware() {
  return function idempotencyMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
  ): void {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const existingKey = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];

    if (existingKey) {
      next();
      return;
    }

    req.headers[IDEMPOTENCY_HEADER.toLowerCase()] = crypto.randomUUID();

    next();
  };
}
