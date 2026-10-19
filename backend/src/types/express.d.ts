import { Request } from "express";

declare global {
  namespace Express {
    interface Request {
      /** Per-request ID set by requestLoggingMiddleware (#2186). */
      requestId?: string;
      admin?: {
        id: string;
        address: string;
        role: string;
      };
    }
  }
}
