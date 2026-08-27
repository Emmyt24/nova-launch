# mTLS Certificate Rotation Runbook

**Issue:** #1630  
**Scope:** Istio mesh, Istio Gateway, and backend service across the `nova-launch` namespace.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture — What Gets Rotated](#2-architecture--what-gets-rotated)
3. [Prerequisites](#3-prerequisites)
4. [Automatic Rotation (Scheduled / CI-Triggered)](#4-automatic-rotation-scheduled--ci-triggered)
5. [Manual Rotation Trigger](#5-manual-rotation-trigger)
6. [Dual-Trust Overlap Window](#6-dual-trust-overlap-window)
7. [Automatic Rollback](#7-automatic-rollback)
8. [Manual Rollback](#8-manual-rollback)
9. [Monitoring During Rotation](#9-monitoring-during-rotation)
10. [Rotation State Machine](#10-rotation-state-machine)
11. [Environment Variables Reference](#11-environment-variables-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Test Harness](#13-test-harness)

---

## 1. Overview

This runbook covers the **zero-downtime mTLS certificate rotation pipeline** for Nova Launch. It issues new certificates, distributes them to all three layers (Istio mesh, Istio Gateway, backend), holds a **dual-trust overlap window** so in-flight and slow-to-update peers are never dropped, and automatically rolls back if the post-rotation connection error rate exceeds a configured threshold.

Key design decisions:
- **No in-flight connection drops** — old and new CAs are both trusted during the overlap window.
- **Automatic rollback** — a Prometheus-based error-rate check watches for 5xx spikes; if the threshold is breached, the previous certificate state is restored automatically.
- **Atomic per-layer distribution** — each layer (istio, gateway, backend) is backed up before being updated; rollback restores from those backups.
- **Idempotent** — the rotation script can be re-run after a partial failure without leaving the cluster in an inconsistent state.

---

## 2. Architecture — What Gets Rotated

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer         │  Kubernetes resource updated                           │
├────────────────┼────────────────────────────────────────────────────────┤
│  Istio mesh    │  Secret/cacerts (namespace: istio-system)              │
│                │  istiod Deployment restart to pick up new root CA      │
├────────────────┼────────────────────────────────────────────────────────┤
│  Istio Gateway │  Secret/nova-launch-tls (namespace: nova-launch)       │
│                │  Istio Gateway resource patched with new credentialName│
├────────────────┼────────────────────────────────────────────────────────┤
│  Backend       │  Secret/backend-mtls-certs (namespace: nova-launch)    │
│                │  backend Deployment restart to reload mounted certs     │
└─────────────────────────────────────────────────────────────────────────┘
```

Certificate storage:
- PEM files are written to `CERT_DIR` (default `/tmp/mtls-rotation`) during rotation.
- Kubernetes Secrets are backed up to `$CERT_DIR/backup-<epoch>/` before any mutation.

---

## 3. Prerequisites

| Requirement | Version / Notes |
|---|---|
| `kubectl` | Configured for the target cluster |
| `curl` | Used to poll Prometheus for error rate |
| `python3` | Used to parse Prometheus JSON response |
| Prometheus | Reachable at `PROMETHEUS_URL` (default `http://localhost:9090`) |
| RBAC | Service account must have `get/patch/create` on Secrets in `istio-system` and `nova-launch`, plus `patch` on Deployments |

For **automatic rotation** triggered by GitHub Actions (see `.github/workflows/`), the workflow uses the cluster kubeconfig stored in the `KUBECONFIG` Actions secret.

---

## 4. Automatic Rotation (Scheduled / CI-Triggered)

Rotation is designed to be triggered automatically (e.g. by a cron job or CI pipeline) when a certificate approaches expiry. The recommended trigger is 30 days before expiry.

```bash
# Standard automatic rotation
./scripts/mtls-rotation/rotate-mtls-certs.sh

# With custom namespace and threshold
./scripts/mtls-rotation/rotate-mtls-certs.sh \
  --namespace nova-launch \
  --threshold 3
```

The script exits `0` on success. Non-zero exit codes indicate failure; see [Exit Codes](#exit-codes).

### Exit Codes

| Code | Meaning |
|---|---|
| 0 | Rotation complete — no action needed |
| 1 | Pre-flight check failed — cluster unreachable or missing tools |
| 2 | Certificate issuance failed — no state was changed |
| 3 | Distribution failed — automatic rollback was attempted |
| 4 | Post-rotation error rate spike — automatic rollback was attempted |
| 5 | Rollback itself failed — **manual intervention required** |

---

## 5. Manual Rotation Trigger

Use this procedure when a certificate is about to expire and you need to rotate outside the normal schedule.

```bash
# 1. Confirm the cert expiry date (example: check the Istio CA Secret)
kubectl get secret cacerts -n istio-system \
  -o jsonpath='{.data.ca-cert\.pem}' \
  | base64 -d | openssl x509 -noout -dates

# 2. Dry-run to preview all actions without applying them
DRY_RUN=true ./scripts/mtls-rotation/rotate-mtls-certs.sh --dry-run

# 3. Perform the rotation
./scripts/mtls-rotation/rotate-mtls-certs.sh

# 4. Verify rotation succeeded
kubectl get secret cacerts -n istio-system \
  -o jsonpath='{.data.ca-cert\.pem}' \
  | base64 -d | openssl x509 -noout -dates
```

---

## 6. Dual-Trust Overlap Window

During rotation, **both the old and new root CA certificates are trusted simultaneously** for `DUAL_TRUST_SECS` seconds (default 300 s = 5 minutes). This prevents any peer that has not yet reloaded its trust bundle from being rejected.

The overlap window is implemented by:
1. **Distributing the new certificate** while leaving the old CA in place (Phase 3 of the rotation).
2. **Monitoring error rates** during the window to detect any regression.
3. **Cutting over** (removing the old CA from all trust bundles) only after the window expires and error rates are healthy.

To extend the overlap window for a slower rollout:

```bash
DUAL_TRUST_SECS=600 ./scripts/mtls-rotation/rotate-mtls-certs.sh
```

---

## 7. Automatic Rollback

Rollback is triggered automatically when the connection error rate (measured as the percentage of 5xx HTTP responses) exceeds `ERROR_RATE_THRESHOLD` (default 5%) during `MONITOR_WINDOW_SECS` (default 120 s) of post-distribution monitoring.

On rollback:
1. Every Kubernetes Secret that was backed up is restored via `kubectl apply`.
2. `istiod` is restarted to pick up the restored Istio CA.
3. The backend deployment is restarted to reload its mounted certificates.
4. The script exits with code `4` (rollback after error spike) or `3` (rollback after distribution failure).

If the rollback itself encounters errors (e.g. backup files missing), the script exits with code `5` and emits:
```
[ERROR] Rollback encountered errors — MANUAL INTERVENTION REQUIRED
[ERROR] Backup files are in: /tmp/mtls-rotation/backup-<epoch>
```

---

## 8. Manual Rollback

If automatic rollback failed (exit code 5) or you need to roll back after the rotation script exited:

```bash
# 1. Locate the backup directory printed at rotation time
ls -lt /tmp/mtls-rotation/

# 2. Restore each backed-up Secret
for yaml in /tmp/mtls-rotation/backup-<epoch>/*.yaml; do
  kubectl apply -f "$yaml" -n nova-launch
done

# Restore Istio CA secret (lives in istio-system)
kubectl apply -f /tmp/mtls-rotation/backup-<epoch>/cacerts.yaml -n istio-system

# 3. Restart Istio to reload CA
kubectl rollout restart deployment/istiod -n istio-system

# 4. Restart backend to reload certs
kubectl rollout restart deployment/backend -n nova-launch

# 5. Confirm rollback
kubectl rollout status deployment/istiod -n istio-system
kubectl rollout status deployment/backend -n nova-launch
```

---

## 9. Monitoring During Rotation

The pipeline polls Prometheus during both the dual-trust window and the post-cutover window. The default PromQL query is:

```promql
100 * sum(rate(http_requests_total{status=~"5.."}[1m]))
      / sum(rate(http_requests_total[1m]))
```

Override the Prometheus URL if your cluster uses a different endpoint:

```bash
PROMETHEUS_URL=http://prometheus.monitoring.svc:9090 \
  ./scripts/mtls-rotation/rotate-mtls-certs.sh
```

Grafana dashboards for mTLS health are available in
`monitoring/grafana/dashboards/nova-infrastructure.json` under the
"Service Mesh / mTLS" panel group.

Alert rules for sustained 5xx spikes are defined in
`monitoring/prometheus/alerts/api.yml`.

---

## 10. Rotation State Machine

```
IDLE
  │
  ▼  (rotation triggered)
ISSUING          ← Phase 1: Generate new cert/key/CA bundle
  │
  ▼  (certs issued)
DUAL_TRUST       ← Phase 2: Backup existing Secrets
  │
  ▼  (backups complete)
MONITORING_POST_DISTRIBUTION  ← Phase 3: Distribute new certs to all 3 layers
  │                                       Monitor error rate
  │
  ├─── error rate spike ──────────────────────────────────────►  ROLLING_BACK
  │                                                                    │
  ▼  (no spike during window)                                         ▼
CUTOVER          ← Phase 4: Remove old CA from trust bundles      ROLLED_BACK
  │
  ▼
MONITORING_POST_CUTOVER  ← Phase 5: Continue monitoring for MONITOR_WINDOW_SECS
  │
  ├─── error rate spike ──────────────────────────────────────►  ROLLING_BACK
  │
  ▼  (clean)
CLEANUP          ← Phase 6: Delete old cert backups / temp files
  │
  ▼
COMPLETE
```

---

## 11. Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `NAMESPACE` | `nova-launch` | Kubernetes namespace for gateway and backend Secrets |
| `ERROR_RATE_THRESHOLD` | `5` | Max acceptable 5xx % before rollback is triggered |
| `MONITOR_WINDOW_SECS` | `120` | Seconds to watch error rate after distribution |
| `DUAL_TRUST_SECS` | `300` | Seconds both old and new CAs are trusted simultaneously |
| `CERT_DIR` | `/tmp/mtls-rotation` | Directory for PEM files and Secret backups |
| `KUBECTL` | `kubectl` | Path to the kubectl binary |
| `DRY_RUN` | `false` | Set to `true` to log all actions without applying them |
| `PROMETHEUS_URL` | `http://localhost:9090` | Prometheus base URL for error-rate queries |

---

## 12. Troubleshooting

### Rotation stuck at "Waiting for Istio reload"

Istio's CA reload can take 30-90 s depending on pod count. Increase
`MONITOR_WINDOW_SECS` or check istiod logs:

```bash
kubectl logs -n istio-system \
  $(kubectl get pod -n istio-system -l app=istiod -o name | head -1) \
  --tail=50
```

### Error rate spike immediately after distribution

This is usually caused by an Envoy proxy that has not yet received the new
certificate. Istio propagates xDS config changes asynchronously; the
dual-trust window accommodates this. If spikes are systematic, increase
`DUAL_TRUST_SECS` to give all sidecars more time to update.

### Exit code 5 — Rollback failed

1. Check if the backup directory still exists:
   ```bash
   ls /tmp/mtls-rotation/backup-*/
   ```
2. If backup files are missing, retrieve the previous Secrets from your
   external secret store (Vault) or backup snapshot.
3. Apply them manually following the [Manual Rollback](#8-manual-rollback) steps.
4. Page on-call via PagerDuty if cluster health is degraded.

---

## 13. Test Harness

Run the full test harness (no live cluster required — uses `DRY_RUN=true`):

```bash
bash scripts/mtls-rotation/verify-mtls-rotation.sh
```

This exercises two scenarios:

- **Scenario A** — full successful rotation cycle  
  `issue → distribute → dual-trust → cutover → cleanup`

- **Scenario B** — rotation requiring rollback  
  `issue → distribute → ERROR SPIKE DETECTED → rollback`

Unit tests for the JS orchestration layer:

```bash
cd scripts/mtls-rotation
npm test          # or: npx vitest run __tests__/mtls-rotation.test.js
```

The test suite covers:

- `CertRotationOrchestrator` state machine through all phases
- Dual-trust window: old + new CA both present during overlap
- Error-rate monitor: passthrough below threshold, rollback trigger above threshold
- Rollback: all three layers (istio, gateway, backend) are restored
- Rollback on distribution failure
- Rollback on post-cutover spike
- `CertificateIssuer`: valid bundle fields
- `ConnectionMonitor`: sustained monitoring and per-check API
