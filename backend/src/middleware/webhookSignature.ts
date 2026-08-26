/**
 * Middleware: verify HMAC signature on inbound webhook payloads (#1157).
 *
 * Usage:
 *   router.post('/inbound', verifyInboundWebhookSignature(getSecret), handler)
 *
 * The caller supplies a `getSecret` function that resolves the shared secret
 * for the given request (e.g. looked up by subscription ID in the path/query).
 * The middleware reads the raw body, verifies the `X-Webhook-Signature` header,
 * and rejects with 401 if the signature is missing or invalid.
 *
 * Signing scheme (identical to outbound):
 *   header = "v1.<timestamp>.<hmac-sha256-hex>"
 *   signed_message = "<timestamp>.<raw_body_string>"
 *
 * Security hardening (#1583):
 * - Constant-time signature comparison via crypto.timingSafeEqual
 * - Replay window enforcement (configurable, default 5 minutes)
 * - Normalized error responses to prevent information leakage about which check failed
 */

import { Request, Response, NextFunction } from "express";
import { verifyWebhookSignature } from "../utils/crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

/** Tolerance window for replay protection (5 minutes in seconds) */
const REPLAY_TOLERANCE_SECONDS = 300;

/**
 * Returns an Express middleware that verifies the inbound HMAC signature.
 *
 * @param getSecret  Async function that receives the request and returns the
 *                   shared secret to verify against. If null/undefined is returned
 *                   (e.g., subscription not found), verification still fails and
 *                   the middleware returns 401 — secrets are always required.
 * @param replayToleranceSeconds Optional custom replay window; defaults to 300s (5 min)
 */
export function verifyInboundWebhookSignature(
  getSecret: (req: Request) => Promise<string | null | undefined>,
  replayToleranceSeconds: number = REPLAY_TOLERANCE_SECONDS
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const signatureHeader =
        req.headers[WEBHOOK_SIGNATURE_HEADER] as string | undefined;

      // Raw body must be available (set by express.raw() or similar)
      const rawBody: string =
        (req as any).rawBody ??
        (Buffer.isBuffer(req.body)
          ? req.body.toString('utf-8')
          : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body));

      const secret = await getSecret(req);

      // Always require a secret: if getSecret returns null/undefined (e.g., subscription not found),
      // verification fails. We never skip verification based on missing secrets because:
      // 1. It prevents confusion about the intended behavior (skip verification is risky)
      // 2. Missing subscription should be handled upstream (404 from a route handler)
      // 3. We still perform a constant-time dummy verify with an empty secret to maintain
      //    timing consistency, preventing attackers from learning whether the failure is due
      //    to a missing secret vs. an invalid signature.
      const valid = verifyWebhookSignature(
        rawBody,
        signatureHeader ?? "",
        secret ?? "",
        replayToleranceSeconds
      );

      if (!valid) {
        res.status(401).json({
          success: false,
          error: "Unauthorized",
        });
        return;
      }

      next();
    } catch (err) {
      res.status(500).json({
        success: false,
        error: "Internal server error",
      });
    }
  };
}
