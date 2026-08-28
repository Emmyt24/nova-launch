# Runbook: Backend Service Down (`BackendDown`)

## Alert Overview

- **Alert Name:** `BackendDown`
- **Severity:** `critical`
- **Team:** `backend`
- **Threshold:** `up{job="nova-backend"} == 0` for more than 1 minute.
- **Dashboard:** [Nova Launch Overview Dashboard](https://grafana.example.com/d/nova-overview?viewPanel=1) (View Panel 1: Platform Health & Uptime)

This alert indicates that Prometheus cannot scrape the backend metrics endpoint (`GET /metrics`), indicating that the backend service container is down, unreachable, crashed, or experiencing network isolation.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Navigate to [Grafana Overview Panel 1](https://grafana.example.com/d/nova-overview?viewPanel=1).
   - Check if this is an isolated backend instance failure or a widespread infrastructure outage.

2. **Check Process / Container State:**
   - Check container status on the host or Kubernetes cluster:
     ```bash
     # Docker / Docker Compose
     docker-compose ps nova-backend

     # Kubernetes
     kubectl get pods -n nova-launch -l app=nova-backend
     ```
   - Check if the container exited, was OOMKilled (exit code 137), or is in `CrashLoopBackOff`.

3. **Check Container Logs & Host Diagnostics:**
   - Inspect the last log entries before termination:
     ```bash
     docker-compose logs --tail=100 nova-backend
     ```
   - Check system memory and kernel logs for OOM killer events:
     ```bash
     dmesg -T | grep -i oom
     ```

4. **Verify Metric Endpoint Connectivity Directly:**
   - Test if the process is responding to direct HTTP requests:
     ```bash
     curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/metrics
     curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/health
     ```

---

## Mitigation & Recovery

1. **Restart the Backend Service:**
   ```bash
   docker-compose restart nova-backend
   ```
2. **Recreate Service Container (if corrupted state):**
   ```bash
   docker-compose up -d --force-recreate nova-backend
   ```
3. **If Out-Of-Memory (OOM):**
   - Increase memory allocation limits in `docker-compose.yml` or Kubernetes resource limits.
   - Investigate memory leaks using heap profiles or Node.js inspect tools.

---

## Rollback & Escalation Path

1. **Rollback to Previous Image:**
   - If the backend crashed immediately after a deployment:
     ```bash
     docker-compose pull nova-backend:<previous-stable-tag>
     docker-compose up -d --no-deps nova-backend
     ```

2. **Escalation:**
   - If the service fails to restart or stay healthy:
     - **Primary:** Page the Backend On-Call Engineer via PagerDuty.
     - **Slack:** Post in `#nova-critical` with container exit codes and crash trace.
     - **Infrastructure:** Involve DevOps/Infra team if underlying host or networking issues are suspected.
