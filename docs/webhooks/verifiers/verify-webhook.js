/**
 * Reference verifier for Nova Launch webhook signatures (v1), Node.js.
 *
 * Usage (Express):
 *
 *   app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
 *     const ok = verifyNovaWebhook(
 *       req.body.toString("utf8"),
 *       req.get("X-Webhook-Signature"),
 *       process.env.NOVA_WEBHOOK_SECRET
 *     );
 *     if (!ok) return res.status(401).end();
 *     res.status(204).end();
 *   });
 *
 * If the delivery carries `Content-Encoding: gzip`, decompress the body first.
 */
const crypto = require("crypto");

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Build the exact string Nova Launch signs: the JSON serialization of
 * `{ event, timestamp, data }` (in that key order, without `signature`).
 */
function canonicalSignedPayload(body) {
  return JSON.stringify({
    event: body.event,
    timestamp: body.timestamp,
    data: body.data,
  });
}

function parseSignatureHeader(header) {
  if (typeof header !== "string") return null;
  const parts = header.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const timestamp = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  return { timestamp, signature: parts[2] };
}

function computeSignature(secret, timestamp, signedPayload) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${signedPayload}`, "utf8")
    .digest("hex");
}

/**
 * @param {string} rawBody     Raw (decompressed) request body.
 * @param {string} header      Value of the X-Webhook-Signature header.
 * @param {string} secret      Subscription secret.
 * @param {object} [options]
 * @param {number} [options.toleranceSeconds=300]  Replay window; pass Infinity to skip.
 * @param {number} [options.now]                   Current unix time in seconds (for tests).
 * @returns {boolean}
 */
function verifyNovaWebhook(rawBody, header, secret, options = {}) {
  const parsed = parseSignatureHeader(header);
  if (!parsed || !secret) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const expected = computeSignature(secret, parsed.timestamp, canonicalSignedPayload(body));
  return crypto.timingSafeEqual(Buffer.from(parsed.signature), Buffer.from(expected));
}

module.exports = {
  verifyNovaWebhook,
  canonicalSignedPayload,
  computeSignature,
  parseSignatureHeader,
};
