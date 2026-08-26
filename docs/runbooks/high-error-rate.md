# Runbook: High HTTP Error Rate (`HighErrorRate`)

## Alert Overview

- **Alert Name:** `HighErrorRate`
- **Severity:** `critical`
- **Team:** `backend`
- **Threshold:** HTTP 5xx error rate exceeds 5% of total requests over a 5-minute window (`(sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))) > 0.05`).
- **Dashboard:** [API Performance Dashboard](https://grafana.example.com/d/nova-api?viewPanel=2) (View Panel 2: Error Rates & Status Codes)

This alert indicates that a substantial proportion of HTTP requests to the Nova Launch backend are failing with internal server errors (HTTP 5xx). This directly impacts end users and degrades application availability.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Navigate to [Grafana Panel 2](https://grafana.example.com/d/nova-api?viewPanel=2).
   - Identify the affected service(s), endpoints/routes, and the breakdown of status codes (500, 502, 503, 504).
   - Check if traffic volume (`http_requests_total`) spiked abruptly.

2. **Inspect Backend Application Logs:**
   - View recent error logs in Kibana or directly via container logs:
     ```bash
     # Docker / Docker Compose
     docker-compose logs --tail=200 -f nova-backend

     # Or Kubernetes
     kubectl logs -n nova-launch -l app=nova-backend --tail=200 --prefix
     ```
   - Look for unhandled exceptions, database connection timeouts, or missing environment configurations.

3. **Check Database and External Dependencies:**
   - Verify PostgreSQL database health and connection pool status:
     ```bash
     docker-compose exec postgres pg_isready
     ```
   - Verify Redis cache and external Soroban / Horizon RPC node availability.

4. **Verify Recent Deployments:**
   - Check if a new version of the backend service or database migration was recently applied:
     ```bash
     git log -n 5 --oneline
     ```

---

## Mitigation & Recovery

1. **Service Restart (if transient deadlock or memory leak):**
   ```bash
   docker-compose restart nova-backend
   ```
2. **Scale Out Backend Instances (if saturated):**
   ```bash
   docker-compose up -d --scale nova-backend=3
   ```
3. **Database Pool Saturation:**
   - If errors are `500 Internal Server Error` due to `Connection pool timeout`, consider increasing pool capacity or restarting hung connections.

---

## Rollback & Escalation Path

1. **Rollback Recent Deployment:**
   - If the issue started immediately following a deployment, roll back to the previous stable release:
     ```bash
     # Revert to previous image / tag
     docker-compose -f docker-compose.yml up -d --no-deps nova-backend
     ```
   - If a database migration caused issues, refer to [Database Migration Rollback Runbook](../MIGRATION_ROLLBACK_RUNBOOK.md).

2. **Escalation:**
   - If the error rate does not normalize within 10 minutes:
     - **Primary:** Page the Backend On-Call Engineer via PagerDuty.
     - **Slack:** Post incident status in `#nova-critical` and `#backend`.
     - **Incident Lead:** Coordinate with Tech Lead if data corruption or third-party outage is suspected.
