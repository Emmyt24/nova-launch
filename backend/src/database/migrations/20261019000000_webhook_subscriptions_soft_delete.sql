-- Issue #2190: soft delete and restore for webhook subscriptions.
-- Deleting a subscription now sets deleted_at instead of removing the row,
-- preserving delivery history and allowing restore within the retention window.
ALTER TABLE webhook_subscriptions
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_subscriptions_deleted_at
    ON webhook_subscriptions(deleted_at);
