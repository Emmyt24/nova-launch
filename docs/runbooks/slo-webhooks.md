# Runbook: Webhook Delivery SLO Burn Rate (`SLOWebhookDeliveryFastBurn` / `SLOWebhookDeliverySlowBurn`)

## Alert Overview

- **Alert Names:**
  - `SLOWebhookDeliveryFastBurn` (P1 / Critical): Webhook failure ratio > 14% over 5m (14× burn rate, exhausts 30-day budget in ~1h)
  - `SLOWebhookDeliverySlowBurn` (P2 / Warning): Webhook failure ratio > 2% over 1h (2× burn rate, exhausts 30-day budget in ~3 days)
- **SLO Target:** > 99% Webhook Delivery Success Rate (Error Budget: 1% over 30 days)
- **Team:** `backend`
- **Dashboard:** [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1) (View Panel 1: SLO Status & Webhook Delivery Metrics)

This alert indicates that outgoing webhook deliveries for platform events (token deployments, state changes, etc.) are failing at an unsustainable rate, risking missed notifications for integrations and external subscribers.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Open the [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1) to verify burn rate magnitude.
   - Open the [API Performance Dashboard](https://grafana.example.com/d/nova-api?viewPanel=1) or Webhooks panel to check delivery volume, failure rates, and retry counts by `event_type`.

2. **Inspect Webhook Worker Logs:**
   - Check logs for HTTP response statuses received from recipient endpoints:
     ```bash
     docker-compose logs --tail=200 nova-backend | grep -i webhook
     ```
   - Determine if failures are widespread across all endpoints (suggesting DNS/networking issues on Nova Launch side) or isolated to specific subscriber URLs (e.g., recipient returning 5xx or timing out).

3. **Check Retry Queue & Worker Status:**
   - Verify if the webhook delivery queue or retry worker is backed up or stalling:
     ```bash
     # Check Redis queue length or worker process health
     docker-compose exec redis redis-cli llen webhook_queue
     ```

---

## Mitigation & Recovery

1. **Endpoint Isolation / Quarantine:**
   - If a single third-party endpoint is continuously failing (e.g., 500 errors or timeout), disable/pause dispatch for that specific endpoint so it does not degrade overall delivery metrics.

2. **Worker Scaling:**
   - If the delivery queue is backing up, increase the concurrency or scale out background workers.

3. **Retry Backoff Adjustment:**
   - Ensure exponential backoff is active to prevent retry storms against degraded downstream receivers.

---

## Rollback & Escalation Path

1. **Rollback:**
   - If a recent release changed webhook payload schemas, signature algorithms, or dispatch logic, roll back the backend service:
     ```bash
     docker-compose -f docker-compose.yml up -d --no-deps nova-backend
     ```

2. **Escalation:**
   - **Fast Burn:** Escalate immediately to Backend On-Call via PagerDuty and notify `#nova-critical`.
   - **Slow Burn:** Notify `#backend` to review failing webhook subscriptions and retry logs.
