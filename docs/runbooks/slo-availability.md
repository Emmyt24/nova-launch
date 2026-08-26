# Runbook: API Availability SLO Burn Rate (`SLOAvailabilityFastBurn` / `SLOAvailabilitySlowBurn`)

## Alert Overview

- **Alert Names:**
  - `SLOAvailabilityFastBurn` (P1 / Critical): 5m error ratio > 1.4% (14× burn rate, exhausts 30-day budget in ~1h)
  - `SLOAvailabilitySlowBurn` (P2 / Warning): 1h error ratio > 0.2% (2× burn rate, exhausts 30-day budget in ~3 days)
- **SLO Target:** 99.9% API Availability (Error Budget: 0.1% = 43.8 minutes over 30 days)
- **Team:** `backend`
- **Dashboard:** [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1) (View Panel 1: SLO Status & Burn Rate Trends)

This alert implements Google SRE multi-window, multi-burn-rate alerting. A fast burn indicates an acute service degradation actively destroying the monthly error budget, while a slow burn indicates a persistent, low-level error rate threatening the SLO.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Open the [SLO Burn Rate Dashboard](https://grafana.example.com/d/nova-slo-burn-rate?viewPanel=1).
   - Review the **API Availability Burn Rate** time series and current remaining error budget.
   - Cross-reference with the [API Performance Dashboard](https://grafana.example.com/d/nova-api?viewPanel=2) to isolate which routes, endpoints, or microservices are generating 5xx responses.

2. **Isolate Error Patterns in Logs:**
   - Filter logs by HTTP status code >= 500:
     ```bash
     docker-compose logs --tail=500 nova-backend | grep -E '"status":(5[0-9]{2})'
     ```
   - Check if errors are concentrated on specific endpoints (e.g., token deployment, transaction submission, user queries).

3. **Check Upstream & Downstream Dependencies:**
   - Inspect PostgreSQL database connection pool and query latency.
   - Verify health of external RPC providers (Stellar Horizon, Soroban RPC).

4. **Verify Deployment & Traffic Anomalies:**
   - Determine if error rate coincides with a recent release, configuration change, or abnormal traffic surge / DDoS.

---

## Mitigation & Recovery

1. **Fast Burn (P1) Immediate Actions:**
   - If triggered following a deployment: execute immediate rollback.
   - If caused by failing downstream dependency: enable circuit breaker or cached fallback modes.
   - If traffic overload: enable rate limiting or scale backend instances horizontally.

2. **Slow Burn (P2) Actions:**
   - Identify low-frequency edge case errors and unhandled exceptions.
   - Create a high-priority bug ticket to remediate before budget exhaustion.

---

## Rollback & Escalation Path

1. **Rollback:**
   - Roll back recent backend deployments:
     ```bash
     docker-compose -f docker-compose.yml up -d --no-deps nova-backend
     ```
   - Revert recent feature flags or configuration updates in Vault / environment.

2. **Escalation:**
   - **For Fast Burn (`SLOAvailabilityFastBurn`):**
     - Immediate P1 escalation via PagerDuty.
     - Post updates in `#nova-critical` and declare an incident.
   - **For Slow Burn (`SLOAvailabilitySlowBurn`):**
     - Notify the `#backend` channel for investigation within normal business hours or next standup.
