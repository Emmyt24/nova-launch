-- Webhook subscriptions table
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url VARCHAR(2048) NOT NULL,
    token_address VARCHAR(56),
    events TEXT[] NOT NULL,
    secret VARCHAR(64) NOT NULL,
    active BOOLEAN DEFAULT true,
    created_by VARCHAR(56) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_triggered TIMESTAMP,
    deleted_at TIMESTAMP,
    custom_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT valid_url CHECK (url ~ '^https?://'),
    CONSTRAINT valid_events CHECK (array_length(events, 1) > 0)
);

-- Webhook delivery logs table
CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    event VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status_code INTEGER,
    success BOOLEAN DEFAULT false,
    attempts INTEGER DEFAULT 1,
    last_attempt_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON webhook_subscriptions(active);
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON webhook_subscriptions(token_address);
CREATE INDEX IF NOT EXISTS idx_subscriptions_created_by ON webhook_subscriptions(created_by);
CREATE INDEX IF NOT EXISTS idx_subscriptions_deleted_at ON webhook_subscriptions(deleted_at);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_subscription ON webhook_delivery_logs(subscription_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_created_at ON webhook_delivery_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_success ON webhook_delivery_logs(success);

-- Rate limiting table
CREATE TABLE IF NOT EXISTS webhook_rate_limits (
    subscription_id UUID PRIMARY KEY REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    request_count INTEGER DEFAULT 0,
    window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT positive_count CHECK (request_count >= 0)
);

-- Dead-letter store for failed webhook deliveries
CREATE TABLE IF NOT EXISTS webhook_dead_letters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
    event VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status_code INTEGER,
    last_error TEXT,
    attempt_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    resolution VARCHAR(50)
);

-- Indexes for dead-letter queries
CREATE INDEX IF NOT EXISTS idx_dead_letters_subscription ON webhook_dead_letters(subscription_id);
CREATE INDEX IF NOT EXISTS idx_dead_letters_created_at ON webhook_dead_letters(created_at);
CREATE INDEX IF NOT EXISTS idx_dead_letters_resolved ON webhook_dead_letters(resolved_at);
