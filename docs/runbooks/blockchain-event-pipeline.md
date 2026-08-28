# Runbook: Blockchain Event Pipeline & Token Deployments (`CriticalEventIngestionLag` / `TokenDeploymentFailures`)

## Alert Overview

This runbook covers critical alerts for the Stellar/Soroban blockchain event ingestion pipeline and token deployment operations:

### 1. `CriticalEventIngestionLag`
- **Severity:** `critical`
- **Team:** `blockchain`
- **Threshold:** P95 event ingestion lag exceeds 120 seconds (2 minutes) for `{{ $labels.event_type }}` over a 3-minute window (`histogram_quantile(0.95, sum(rate(event_ingestion_lag_seconds_bucket[5m])) by (le, event_type)) > 120`).
- **Dashboard:** [Blockchain Activity Dashboard](https://grafana.example.com/d/nova-blockchain?viewPanel=1) (View Panel 1: Ingestion Lag & Throughput)

### 2. `TokenDeploymentFailures`
- **Severity:** `critical`
- **Team:** `blockchain`
- **Threshold:** Token deployment failure rate exceeds 10% over 10 minutes on `{{ $labels.network }}` (`(sum(rate(token_deployments_total{status="failure"}[10m])) by (network) / sum(rate(token_deployments_total[10m])) by (network)) > 0.10`).
- **Dashboard:** [Blockchain Activity Dashboard](https://grafana.example.com/d/nova-blockchain?viewPanel=1) (View Panel 1: Deployment Success Rates)

---

## First Diagnostic Steps

### Diagnosing Event Ingestion Lag
1. **Check Dashboard Ingestion Panel:**
   - Open [Blockchain Activity Dashboard](https://grafana.example.com/d/nova-blockchain?viewPanel=1).
   - Check which `event_type` is lagging and whether event processing rate has dropped to zero.
2. **Inspect Event Poller Logs:**
   - Check worker logs for unhandled exceptions or blocked ledger streaming:
     ```bash
     docker-compose logs --tail=200 nova-backend | grep -i "event_ingestion"
     ```
3. **Check Ledger Ingestion Cursor:**
   - Verify if the ingestion worker is stuck on a specific ledger height or parsing error.
   - Cross-check current network ledger vs. last indexed ledger in database.

### Diagnosing Token Deployment Failures
1. **Inspect Deployment Error Logs:**
   - View recent contract deployment error responses:
     ```bash
     docker-compose logs --tail=200 nova-backend | grep -i "token_deployment"
     ```
2. **Check Deployer Account Balances & Sequence Numbers:**
   - Ensure the deployer account has sufficient XLM balance for transaction and storage fees:
     ```bash
     soroban keys address admin
     # Check account details on network explorer or via CLI
     ```
3. **Verify Contract WASM & Network Parameters:**
   - Ensure the WASM hash configured in the factory contract exists on-chain and has not expired (TTL expiration).

---

## Mitigation & Recovery

### Ingestion Pipeline Recovery
1. **Restart Ingestion Worker:**
   ```bash
   docker-compose restart nova-backend
   ```
2. **Event Replay / Cursor Resync:**
   - If events were missed or the stream stalled, follow the [Event Replay & Recovery Guide](../EVENT_REPLAY_RECOVERY.md) to re-index from a specific ledger sequence.

### Token Deployment Recovery
1. **Account Sequence Desync:**
   - If errors indicate `txBAD_SEQ`, re-fetch the account sequence number from the network.
2. **Gas Fee Spikes:**
   - If Stellar network congestion is causing transactions to drop, increase `MAX_FEE` configuration.
3. **Account Funding:**
   - Transfer additional XLM to the deployer account if balance is below the required reserve threshold.

---

## Rollback & Escalation Path

1. **Rollback:**
   - If issue was introduced by a new contract release or worker logic, roll back using [Contract Upgrade Compatibility](../CONTRACT_UPGRADE_COMPATIBILITY.md) or standard backend rollback procedures.

2. **Escalation:**
   - **Primary:** Page Blockchain On-Call Engineer via PagerDuty.
   - **Slack:** Post status update in `#nova-blockchain` and `#nova-critical`.
