# Webhook Signature Verification (v1)

## Overview

Every webhook delivery from Nova Launch is signed with an HMAC-SHA256
signature derived from the destination subscription's secret. Receivers
should verify this signature before trusting a delivery's payload.

## Header

The signature is sent in the `X-Webhook-Signature` request header:

```
X-Webhook-Signature: v1.<unix_timestamp>.<hmac_sha256_hex>
```

| Part | Meaning |
|------|---------|
| `v1` | Signature scheme version |
| `unix_timestamp` | Seconds since epoch when the signature was generated |
| `hmac_sha256_hex` | Hex-encoded HMAC-SHA256 digest |

## Signing algorithm

| Property | Value |
|----------|-------|
| Algorithm | HMAC-SHA256 |
| Key | The subscription secret (UTF-8 string, shown once at creation) |
| Digest encoding | Lowercase hex (64 characters) |
| Timestamp | Unix seconds, also embedded in the header |

## Signed message

The digest is computed over:

```
<unix_timestamp>.<signed_payload>
```

`signed_payload` is the compact JSON serialization of the delivery body
**without** its `signature` field, with keys in this order:

```json
{"event":"…","timestamp":"…","data":{…}}
```

The request body itself also contains a `signature` field (equal to the
header value), so receivers must rebuild `signed_payload` from the parsed
body rather than hashing the raw bytes. Serialize with no whitespace and
without escaping non-ASCII characters — `JSON.stringify` in JavaScript, or
`json.dumps(obj, separators=(",", ":"), ensure_ascii=False)` in Python.

If the delivery has `Content-Encoding: gzip`, decompress the body before
parsing it.

## Verifying a delivery (pseudocode)

```text
header = request.headers["X-Webhook-Signature"]      # "v1.<ts>.<hex>"
version, timestamp, signature = header.split(".")
require version == "v1"

body = json_parse(raw_body)
signed_payload = compact_json({event: body.event, timestamp: body.timestamp, data: body.data})
expected = hmac_sha256_hex(key=subscription_secret, message=f"{timestamp}.{signed_payload}")

if not constant_time_equal(signature, expected):
    reject()

# Recommended: also reject if abs(now() - timestamp) exceeds your
# acceptable replay window (Nova Launch uses 300 seconds for inbound
# verification).
```

A reference implementation lives in
[`backend/src/utils/crypto.ts`](../backend/src/utils/crypto.ts)
(`generateWebhookSignature` / `verifyWebhookSignature`).

## Sample verifiers

- Node.js: [`docs/webhooks/verifiers/verify-webhook.js`](webhooks/verifiers/verify-webhook.js)
- Python: [`docs/webhooks/verifiers/verify_webhook.py`](webhooks/verifiers/verify_webhook.py)
  (run it directly to check it against the test vectors)

Both use a constant-time comparison and a 300-second replay window by default.

## Test vectors

[`docs/webhooks/signature-test-vectors.json`](webhooks/signature-test-vectors.json)
lists known inputs and outputs. Each vector has `secret`, `timestamp`,
`payload`, the exact `signedPayload` string, `expectedSignature` (hex) and
`expectedHeader`. Use these to test your verifier; when testing the replay
window, treat the vector's `timestamp` as "now".

Example (first vector):

```
secret          = whsec_test_0123456789abcdef0123456789abcdef
timestamp       = 1760000000
expectedHeader  = v1.1760000000.2cc81aa67635cc2d7fb051ae2e9f542c3b966627409ae2bd461f851b64ae673e
```

The backend test `backend/src/__tests__/webhookSignatureVectors.test.ts`
checks the vectors against the signing implementation and both sample
verifiers, so they cannot drift silently.

## Checking a past delivery in the dashboard

The delivery log viewer's verification badge (✓ verified / ✗ unverified)
recomputes this same signature server-side, using the subscription's
*current* secret, against the payload exactly as it was stored at delivery
time. An **unverified** result usually means:

- The subscription's secret was rotated after this delivery was sent.
- The stored payload or signature was corrupted or tampered with.

The badge also shows the last 8 characters of the signing key
(`keyId`) so you can confirm whether a mismatch lines up with a known key
rotation.
