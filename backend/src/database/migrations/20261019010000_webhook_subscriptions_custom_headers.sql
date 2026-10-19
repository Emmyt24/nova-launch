-- Issue #2193: per-webhook custom headers.
-- Stored as a JSON array of {name, value, sensitive}. Values of sensitive
-- headers are AES-256-GCM encrypted (WEBHOOK_HEADER_ENCRYPTION_KEY).
ALTER TABLE webhook_subscriptions
    ADD COLUMN IF NOT EXISTS custom_headers JSONB NOT NULL DEFAULT '[]'::jsonb;
