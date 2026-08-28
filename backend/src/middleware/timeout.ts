import { Request, Response, NextFunction } from "express";

/**
 * Default timeout in milliseconds.
 * Can be overridden via the REQUEST_TIMEOUT_MS environment variable.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Reads the configured timeout from the environment, falling back to the default.
 */
export function getTimeoutMs(): number {
  const raw = process.env.REQUEST_TIMEOUT_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Express middleware that enforces a per-request timeout with graceful degradation.
 *
 * Behaviour:
 * - Sets a timer for `timeoutMs` milliseconds after the request arrives.
 * - If the response has not been sent before the timer fires, responds with
 *   HTTP 503 and a JSON error body so clients receive a structured error
 *   rather than a hanging connection.
 * - Clears the timer on `res.finish` / `res.close` so there is no leak for
 *   requests that complete normally.
 * - Skips already-sent responses to avoid "headers already sent" errors.
 *
 * @param timeoutMs - Milliseconds before a request is considered timed out.
 *                    Defaults to `getTimeoutMs()`.
 */
export function createTimeoutMiddleware(timeoutMs: number = getTimeoutMs()) {
  return function timeoutMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;

      // Graceful degradation: if headers haven't been sent yet, return a
      // structured 503 so the client knows the request timed out.
      if (!res.headersSent) {
        res.status(503).json({
          success: false,
          error: {
            code: "REQUEST_TIMEOUT",
            message: `Request timed out after ${timeoutMs}ms`,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // The downstream handler is still running concurrently. Once we have
      // sent the timeout response, any later attempt by that handler to write
      // to `res` (e.g. res.json()/res.send()/res.end()) would throw
      // "Cannot set headers after they are sent" and surface as an unhandled
      // rejection. Neutralise those late writes so they become safe no-ops.
      const noop = function (): Response {
        return res;
      };
      res.json = noop as unknown as Response["json"];
      res.send = noop as unknown as Response["send"];
      res.end = (noop as unknown as Response["end"]).bind(res);
    }, timeoutMs);

    // Attach the flag so downstream handlers can check it if needed.
    (req as Request & { timedOut?: boolean }).timedOut = false;

    // Clean up the timer once the response is finished or the connection closes.
    const cleanup = () => {
      clearTimeout(timer);
      if (timedOut) {
        (req as Request & { timedOut?: boolean }).timedOut = true;
      }
    };

    res.on("finish", cleanup);
    res.on("close", cleanup);

    next();
  };
}
