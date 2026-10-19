"""Reference verifier for Nova Launch webhook signatures (v1), Python 3.

Usage (Flask):

    @app.post("/webhook")
    def webhook():
        if not verify_nova_webhook(
            request.get_data(as_text=True),
            request.headers.get("X-Webhook-Signature"),
            os.environ["NOVA_WEBHOOK_SECRET"],
        ):
            abort(401)
        return "", 204

If the delivery carries ``Content-Encoding: gzip``, decompress the body first.
Run ``python3 verify_webhook.py`` to check this file against the published
test vectors.
"""

import hashlib
import hmac
import json
import re
import time
from typing import Optional, Tuple

DEFAULT_TOLERANCE_SECONDS = 300
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def canonical_signed_payload(body: dict) -> str:
    """Serialize ``{event, timestamp, data}`` exactly as JavaScript's JSON.stringify does."""
    return json.dumps(
        {"event": body.get("event"), "timestamp": body.get("timestamp"), "data": body.get("data")},
        separators=(",", ":"),
        ensure_ascii=False,
    )


def parse_signature_header(header: Optional[str]) -> Optional[Tuple[int, str]]:
    if not isinstance(header, str):
        return None
    parts = header.split(".")
    if len(parts) != 3 or parts[0] != "v1" or not parts[1].isdigit() or not _HEX64.match(parts[2]):
        return None
    return int(parts[1]), parts[2]


def compute_signature(secret: str, timestamp: int, signed_payload: str) -> str:
    message = f"{timestamp}.{signed_payload}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def verify_nova_webhook(
    raw_body: str,
    header: Optional[str],
    secret: str,
    tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> bool:
    parsed = parse_signature_header(header)
    if parsed is None or not secret:
        return False
    timestamp, signature = parsed

    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return False

    try:
        body = json.loads(raw_body)
    except ValueError:
        return False

    expected = compute_signature(secret, timestamp, canonical_signed_payload(body))
    return hmac.compare_digest(signature, expected)


if __name__ == "__main__":
    import os

    path = os.path.join(os.path.dirname(__file__), "..", "signature-test-vectors.json")
    with open(path, encoding="utf-8") as fh:
        vectors = json.load(fh)["vectors"]
    for v in vectors:
        body = json.dumps({**v["payload"], "signature": v["expectedHeader"]})
        ok = verify_nova_webhook(body, v["expectedHeader"], v["secret"], now=v["timestamp"])
        print(f"{'PASS' if ok else 'FAIL'}  {v['name']}")
