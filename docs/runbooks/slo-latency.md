# Runbook: API Latency SLO Burn Rate (`SLOLatencyFastBurn` / `SLOLatencySlowBurn`)

## Alert Overview

- **Alert Names:**
  - `SLOLatencyFastBurn` (P1 / Critical): > 14% of requests exceed 500ms over 5m (14× burn rate, exhausts 30-day budget in ~1h)
  - `SLOLatencySlowBurn` (P2 / Warning): > 2% of requests exceed 500ms over 1h (2× burn rate, exhausts 30-day budget in ~3 days)
- **SLO Target:** 99% of API requests completed in < 500ms (p95 latency target)
- **Team:** `backend`
- **Dashboard:** [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1) (View Panel 1: SLO Status & Latency Burn Rates)

This alert triggers when an excessive percentage of API requests breach the 500ms latency objective, risking overall platform responsiveness and SLA compliance.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Open the [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1) to assess the rate of budget consumption.
   - Open the [API Performance Dashboard](https://grafana.example.com/d/nova-api?viewPanel=1) to identify which routes have elevated p95 and p99 durations.

2. **Identify Bottleneck Layer:**
   - **Database:** Check slow query logs and active connection pool wait times.
   - **Blockchain / RPC:** Check if calls to Soroban RPC or Stellar nodes are timing out or slow.
   - **Compute/Host:** Check CPU and memory utilization on backend nodes in [Infrastructure Dashboard](https://grafana.example.com/d/nova-infra?viewPanel=1).
   - **Event loop:** Check Node.js event loop lag and GC pause durations.

3. **Check Network & External Services:**
   - Test round-trip latency to upstream Stellar Horizon and Soroban RPC providers.

---

## Mitigation & Recovery

1. **Horizontal Scaling:**
   - Increase instance count to distribute load if CPU or event loop is saturated:
     ```bash
     docker-compose up -d --scale nova-backend=4
     ```

2. **Database Optimization:**
   - Kill long-running blocking queries if database contention is identified:
     ```sql
     SELECT pid, query, now() - query_start AS duration
     FROM pg_stat_activity
     WHERE state != 'idle' AND now() - query_start > interval '5 seconds';
     ```

3. **Caching & Rate Limiting:**
   - Enable or warm up Redis read caches for high-frequency queries.

---

## Rollback & Escalation Path

1. **Rollback:**
   - If high latency followed a new code or schema release, revert the deployment immediately:
     ```bash
     docker-compose -f docker-compose.yml up -d --no-deps nova-backend
     ```

2. **Escalation:**
   - **Fast Burn:** Page Backend On-Call immediately via PagerDuty and notify `#nova-critical`.
   - **Slow Burn:** Notify `#backend` for profiling and query optimization.
