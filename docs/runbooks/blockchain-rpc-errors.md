# Runbook: Blockchain RPC Errors (`HighRPCErrorRate`)

## Alert Overview

- **Alert Name:** `HighRPCErrorRate`
- **Severity:** `critical`
- **Team:** `blockchain`
- **Threshold:** RPC error rate exceeds 10% over a 5-minute window for 3 minutes (`(sum(rate(rpc_errors_total[5m])) by (endpoint) / sum(rate(rpc_calls_total[5m])) by (endpoint)) > 0.10`).
- **Dashboard:** [Blockchain Activity Dashboard](https://grafana.example.com/d/nova-blockchain?viewPanel=1) (View Panel 1: RPC Metrics & Ingestion Health)

This alert fires when calls from Nova Launch services to Stellar Horizon or Soroban RPC endpoints experience a high error rate (> 10%). This can prevent transaction simulation, fee estimation, token deployments, and contract invocations.

---

## First Diagnostic Steps

1. **Check the Grafana Dashboard:**
   - Open the [Blockchain Activity Dashboard](https://grafana.example.com/d/nova-blockchain?viewPanel=1).
   - Identify the affected endpoint (`{{ $labels.endpoint }}`), request rates, error codes, and latency distributions.

2. **Inspect Backend RPC Logs:**
   - Search for specific RPC error messages:
     ```bash
     docker-compose logs --tail=200 nova-backend | grep -i "rpc_error"
     ```
   - Look for HTTP status codes (e.g., 429 Rate Limited, 502/503 Bad Gateway/Unavailable) or JSON-RPC error codes.

3. **Verify Upstream RPC Health Directly:**
   - Execute a health check query against the configured RPC endpoint:
     ```bash
     # Soroban RPC health query
     curl -s -X POST "${SOROBAN_RPC_URL}" \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
     ```
   - Check if the upstream provider status page reports an active incident.

4. **Check Network & DNS Connectivity:**
   - Confirm outgoing HTTPS connectivity from the backend container to the RPC host.

---

## Mitigation & Recovery

1. **Fail Over to Backup RPC Provider:**
   - If using a multi-provider setup or standby node, update `SOROBAN_RPC_URL` or `STELLAR_RPC_URL` in the environment:
     ```bash
     # Update environment in .env or Vault, then reload
     docker-compose up -d --no-deps nova-backend
     ```
2. **Mitigate Rate Limiting (HTTP 429):**
   - If requests are throttled, temporarily reduce ingestion poll frequency or increase API key tier with the provider.
3. **Restart RPC Client Pool:**
   - If connections hung or socket pool exhausted:
     ```bash
     docker-compose restart nova-backend
     ```

---

## Rollback & Escalation Path

1. **Rollback:**
   - If recent backend changes modified RPC interaction logic or batch sizes, revert to the last stable deployment.

2. **Escalation:**
   - **Primary:** Page Blockchain On-Call Engineer via PagerDuty.
   - **Slack:** Post status in `#nova-blockchain` and `#nova-critical`.
