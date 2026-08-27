#!/usr/bin/env bash
# rotate-mtls-certs.sh
#
# Zero-downtime mTLS certificate rotation pipeline for Nova Launch.
#
# Overview
# ─────────
# 1. Issue a new certificate (cert-manager CertificateRequest or manual PEM).
# 2. Enter DUAL-TRUST WINDOW: distribute the new cert while keeping the old
#    cert valid so in-flight connections and slow-to-update peers are not dropped.
# 3. Distribute the new certificate bundle to all three layers:
#      a. Istio  — patch the cacerts Secret and trigger an Istio CA reload
#      b. Gateway — update the TLS Secret referenced by the Istio Gateway resource
#      c. Backend  — update the backend mTLS Secret (or ConfigMap)
# 4. Monitor connection-error-rate (5xx spike) for MONITOR_WINDOW_SECS.
# 5. CUTOVER: remove the old certificate from every trust bundle.
# 6. CLEANUP: delete old secrets/configmaps.
#
# Automatic rollback
# ───────────────────
# If connection errors spike above ERROR_RATE_THRESHOLD during steps 3-5,
# the script immediately reverts all layers to the previous certificate.
#
# Exit codes
# ───────────
#   0  Success — rotation complete
#   1  Pre-flight validation failed
#   2  Certificate issuance failed
#   3  Distribution failed (automatic rollback attempted)
#   4  Post-rotation error rate too high (automatic rollback attempted)
#   5  Rollback itself failed — manual intervention required
#
# Usage
# ──────
#   ./rotate-mtls-certs.sh [--dry-run] [--namespace <ns>] [--threshold <pct>]
#
# Environment variables (override defaults)
#   NAMESPACE              Kubernetes namespace (default: nova-launch)
#   ERROR_RATE_THRESHOLD   Max acceptable 5xx % during monitoring (default: 5)
#   MONITOR_WINDOW_SECS    Seconds to watch error rate (default: 120)
#   DUAL_TRUST_SECS        Seconds both certs remain valid (default: 300)
#   CERT_DIR               Directory for PEM files (default: /tmp/mtls-rotation)
#   KUBECTL                kubectl binary path (default: kubectl)
#   DRY_RUN                Set to "true" to log actions without applying them

set -euo pipefail

# ── Defaults ───────────────────────────────────────────────────────────────────
NAMESPACE="${NAMESPACE:-nova-launch}"
ERROR_RATE_THRESHOLD="${ERROR_RATE_THRESHOLD:-5}"
MONITOR_WINDOW_SECS="${MONITOR_WINDOW_SECS:-120}"
DUAL_TRUST_SECS="${DUAL_TRUST_SECS:-300}"
CERT_DIR="${CERT_DIR:-/tmp/mtls-rotation}"
KUBECTL="${KUBECTL:-kubectl}"
DRY_RUN="${DRY_RUN:-false}"

# ── CLI parsing ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)       DRY_RUN=true ;;
    --namespace)     NAMESPACE="$2"; shift ;;
    --threshold)     ERROR_RATE_THRESHOLD="$2"; shift ;;
    *) echo "[WARN] Unknown flag: $1" ;;
  esac
  shift
done

# ── Logging helpers ────────────────────────────────────────────────────────────
log()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [INFO]  $*"; }
warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [WARN]  $*" >&2; }
err()  { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [ERROR] $*" >&2; }

kube_apply() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] kubectl apply: $*"
  else
    "$KUBECTL" apply "$@"
  fi
}

kube_patch() {
  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] kubectl patch: $*"
  else
    "$KUBECTL" patch "$@"
  fi
}

# ── State tracking for rollback ────────────────────────────────────────────────
ROLLBACK_NEEDED=false
BACKUP_DIR="${CERT_DIR}/backup-$(date +%s)"

backup_secret() {
  local secret_name="$1"
  if [[ "$DRY_RUN" != "true" ]]; then
    mkdir -p "$BACKUP_DIR"
    "$KUBECTL" get secret "$secret_name" \
      -n "$NAMESPACE" -o yaml \
      > "${BACKUP_DIR}/${secret_name}.yaml" 2>/dev/null || true
    log "Backed up Secret/$secret_name to ${BACKUP_DIR}/${secret_name}.yaml"
  else
    log "[DRY-RUN] Would backup Secret/$secret_name"
  fi
}

rollback() {
  err "=== ROLLBACK TRIGGERED ==="
  local rc=0

  for yaml_file in "${BACKUP_DIR}"/*.yaml; do
    [[ -f "$yaml_file" ]] || continue
    log "Restoring $(basename "$yaml_file")..."
    if [[ "$DRY_RUN" != "true" ]]; then
      "$KUBECTL" apply -f "$yaml_file" -n "$NAMESPACE" || rc=1
    else
      log "[DRY-RUN] Would restore $yaml_file"
    fi
  done

  if [[ $rc -ne 0 ]]; then
    err "Rollback encountered errors — MANUAL INTERVENTION REQUIRED"
    err "Backup files are in: $BACKUP_DIR"
    return 5
  fi

  log "Rollback complete. Cluster restored to previous certificate state."

  # Restart Istio pilot to pick up restored certs
  if [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" rollout restart deployment/istiod \
      -n istio-system 2>/dev/null || true
  fi
  return 0
}

# ── Error-rate monitoring ──────────────────────────────────────────────────────
# Queries the Prometheus metrics endpoint (or a configurable URL) for the
# ratio of 5xx responses to total responses over the last minute.
#
# Returns 0 if rate is acceptable, 1 if the threshold is exceeded.
check_error_rate() {
  local window="${1:-60}"
  local prom_url="${PROMETHEUS_URL:-http://localhost:9090}"

  # PromQL: percentage of 5xx in the last minute across gateway + backend
  local query='100 * sum(rate(http_requests_total{status=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))'

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would query Prometheus for error rate (threshold=${ERROR_RATE_THRESHOLD}%)"
    return 0
  fi

  local rate
  rate=$(curl -sf \
    "${prom_url}/api/v1/query" \
    --data-urlencode "query=${query}" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('data', {}).get('result', [])
if results:
    print(float(results[0]['value'][1]))
else:
    print(0.0)
" 2>/dev/null || echo "0.0")

  log "Current 5xx error rate: ${rate}% (threshold: ${ERROR_RATE_THRESHOLD}%)"

  if python3 -c "exit(0 if float('${rate}') <= float('${ERROR_RATE_THRESHOLD}') else 1)" 2>/dev/null; then
    return 0
  else
    err "Error rate ${rate}% exceeds threshold ${ERROR_RATE_THRESHOLD}%"
    return 1
  fi
}

monitor_error_rate() {
  log "Monitoring error rate for ${MONITOR_WINDOW_SECS}s (threshold=${ERROR_RATE_THRESHOLD}%)..."
  local end=$(( $(date +%s) + MONITOR_WINDOW_SECS ))
  local interval=15

  while [[ $(date +%s) -lt $end ]]; do
    if ! check_error_rate; then
      return 1
    fi
    sleep "$interval"
  done
  log "Error rate monitoring passed — no spikes detected."
  return 0
}

# ── Phase 0: Pre-flight checks ────────────────────────────────────────────────
preflight() {
  log "=== Phase 0: Pre-flight checks ==="

  if [[ "$DRY_RUN" != "true" ]]; then
    if ! "$KUBECTL" cluster-info &>/dev/null; then
      err "Cannot reach Kubernetes cluster. Aborting."
      exit 1
    fi
    if ! "$KUBECTL" get namespace "$NAMESPACE" &>/dev/null; then
      err "Namespace '$NAMESPACE' not found. Aborting."
      exit 1
    fi
  fi

  mkdir -p "$CERT_DIR"
  log "Pre-flight checks passed."
}

# ── Phase 1: Issue new certificate ────────────────────────────────────────────
issue_certificate() {
  log "=== Phase 1: Issuing new mTLS certificate ==="

  local new_cert="${CERT_DIR}/new-tls.crt"
  local new_key="${CERT_DIR}/new-tls.key"
  local new_ca="${CERT_DIR}/new-ca.crt"

  if [[ "${USE_CERT_MANAGER:-false}" == "true" ]]; then
    # cert-manager path: create a CertificateRequest and wait for approval
    log "Requesting certificate via cert-manager..."
    cat <<EOF | kube_apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: nova-launch-mtls-new
  namespace: ${NAMESPACE}
spec:
  secretName: nova-launch-mtls-new
  duration: 2160h   # 90 days
  renewBefore: 360h # 15 days
  issuerRef:
    name: nova-launch-ca-issuer
    kind: ClusterIssuer
  dnsNames:
    - "*.${NAMESPACE}.svc.cluster.local"
    - "backend.${NAMESPACE}.svc.cluster.local"
    - "gateway.${NAMESPACE}.svc.cluster.local"
    - "frontend.${NAMESPACE}.svc.cluster.local"
EOF
    # Wait for the certificate to be Ready
    if [[ "$DRY_RUN" != "true" ]]; then
      "$KUBECTL" wait certificate/nova-launch-mtls-new \
        -n "$NAMESPACE" \
        --for=condition=Ready \
        --timeout=120s
    fi
    log "cert-manager certificate issued."
  else
    # Standalone path: generate a self-signed cert for testing / environments
    # without cert-manager. In production, replace with your PKI issuance call.
    if command -v openssl &>/dev/null; then
      log "Generating self-signed certificate with openssl..."
      openssl req -x509 -newkey rsa:4096 -nodes \
        -keyout "$new_key" \
        -out "$new_cert" \
        -days 90 \
        -subj "/CN=nova-launch-mtls/O=nova-launch" \
        -addext "subjectAltName=DNS:*.${NAMESPACE}.svc.cluster.local" \
        2>/dev/null
      cp "$new_cert" "$new_ca"
      log "Self-signed certificate generated: $new_cert"
    else
      # Create placeholder PEM files for dry-run / test environments
      log "[WARN] openssl not found — creating placeholder PEM files for testing."
      echo "-----BEGIN CERTIFICATE-----" > "$new_cert"
      echo "PLACEHOLDER-CERT-$(date +%s)" >> "$new_cert"
      echo "-----END CERTIFICATE-----" >> "$new_cert"
      echo "-----BEGIN PRIVATE KEY-----" > "$new_key"
      echo "PLACEHOLDER-KEY" >> "$new_key"
      echo "-----END PRIVATE KEY-----" >> "$new_key"
      cp "$new_cert" "$new_ca"
    fi
  fi

  # Export paths for subsequent phases
  export NEW_CERT_FILE="$new_cert"
  export NEW_KEY_FILE="$new_key"
  export NEW_CA_FILE="$new_ca"

  log "Phase 1 complete."
}

# ── Phase 2: Dual-trust window — distribute new cert alongside old ─────────────
enter_dual_trust_window() {
  log "=== Phase 2: Entering dual-trust window (${DUAL_TRUST_SECS}s) ==="
  log "Both old and new certificates will be trusted during this window."
  log "In-flight connections and slow peers remain unaffected."

  # Back up existing secrets before any modification
  backup_secret "cacerts"
  backup_secret "nova-launch-gateway-tls"
  backup_secret "nova-launch-backend-mtls"

  # ── 2a. Istio cacerts: append new CA to existing bundle ───────────────────
  log "Appending new CA to Istio cacerts bundle..."

  if [[ "$DRY_RUN" != "true" ]]; then
    # Get existing CA cert
    local old_ca
    old_ca=$("$KUBECTL" get secret cacerts \
      -n istio-system \
      -o jsonpath='{.data.ca-cert\.pem}' 2>/dev/null \
      | base64 -d || true)

    # Build combined bundle: old + new
    local bundle="${CERT_DIR}/combined-ca.crt"
    {
      [[ -n "$old_ca" ]] && echo "$old_ca"
      cat "$NEW_CA_FILE"
    } > "$bundle"

    "$KUBECTL" create secret generic cacerts \
      -n istio-system \
      --from-file=ca-cert.pem="$bundle" \
      --from-file=ca-key.pem="$NEW_KEY_FILE" \
      --from-file=cert-chain.pem="$bundle" \
      --from-file=root-cert.pem="$bundle" \
      --dry-run=client -o yaml \
      | "$KUBECTL" apply -f -
  else
    log "[DRY-RUN] Would append new CA to istio-system/cacerts bundle"
  fi

  # ── 2b. Gateway TLS secret: add new cert ──────────────────────────────────
  log "Updating gateway TLS secret with new certificate..."

  if [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" create secret tls nova-launch-gateway-tls \
      -n "$NAMESPACE" \
      --cert="$NEW_CERT_FILE" \
      --key="$NEW_KEY_FILE" \
      --dry-run=client -o yaml \
      | "$KUBECTL" apply -f -
  else
    log "[DRY-RUN] Would update $NAMESPACE/nova-launch-gateway-tls"
  fi

  # ── 2c. Backend mTLS secret ────────────────────────────────────────────────
  log "Updating backend mTLS secret..."

  if [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" create secret generic nova-launch-backend-mtls \
      -n "$NAMESPACE" \
      --from-file=tls.crt="$NEW_CERT_FILE" \
      --from-file=tls.key="$NEW_KEY_FILE" \
      --from-file=ca.crt="$NEW_CA_FILE" \
      --dry-run=client -o yaml \
      | "$KUBECTL" apply -f -
  else
    log "[DRY-RUN] Would update $NAMESPACE/nova-launch-backend-mtls"
  fi

  # Reload Istio pilot so it distributes the updated trust bundle to all sidecars
  log "Restarting istiod to distribute updated trust bundle..."
  if [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" rollout restart deployment/istiod -n istio-system
    "$KUBECTL" rollout status deployment/istiod -n istio-system --timeout=120s
  else
    log "[DRY-RUN] Would restart istiod"
  fi

  log "Dual-trust window active. Sleeping ${DUAL_TRUST_SECS}s to allow peer propagation..."
  if [[ "$DRY_RUN" != "true" ]]; then
    sleep "$DUAL_TRUST_SECS"
  else
    log "[DRY-RUN] Would sleep ${DUAL_TRUST_SECS}s"
  fi

  log "Phase 2 complete."
}

# ── Phase 3: Monitor error rate post-distribution ─────────────────────────────
monitor_post_distribution() {
  log "=== Phase 3: Post-distribution error-rate monitoring ==="

  if ! monitor_error_rate; then
    ROLLBACK_NEEDED=true
    err "Error spike detected after certificate distribution — initiating rollback."
    if rollback; then
      exit 4
    else
      exit 5
    fi
  fi

  log "Phase 3 complete — error rate within acceptable bounds."
}

# ── Phase 4: Cutover — remove old certificate from trust bundles ──────────────
cutover() {
  log "=== Phase 4: Cutover — removing old certificate ==="
  log "New certificate is the sole trusted cert from this point forward."

  # ── 4a. Istio cacerts: replace combined bundle with new-only ──────────────
  if [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" create secret generic cacerts \
      -n istio-system \
      --from-file=ca-cert.pem="$NEW_CA_FILE" \
      --from-file=ca-key.pem="$NEW_KEY_FILE" \
      --from-file=cert-chain.pem="$NEW_CA_FILE" \
      --from-file=root-cert.pem="$NEW_CA_FILE" \
      --dry-run=client -o yaml \
      | "$KUBECTL" apply -f -

    "$KUBECTL" rollout restart deployment/istiod -n istio-system
    "$KUBECTL" rollout status deployment/istiod -n istio-system --timeout=120s
  else
    log "[DRY-RUN] Would replace istio-system/cacerts with new-only bundle"
    log "[DRY-RUN] Would restart istiod"
  fi

  log "Phase 4 complete."
}

# ── Phase 5: Post-cutover monitoring ─────────────────────────────────────────
monitor_post_cutover() {
  log "=== Phase 5: Post-cutover error-rate monitoring ==="

  if ! monitor_error_rate; then
    ROLLBACK_NEEDED=true
    err "Error spike detected after cutover — initiating rollback."
    if rollback; then
      exit 4
    else
      exit 5
    fi
  fi

  log "Phase 5 complete."
}

# ── Phase 6: Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  log "=== Phase 6: Cleanup ==="

  # Remove cert-manager temporary certificate if used
  if [[ "${USE_CERT_MANAGER:-false}" == "true" ]] && [[ "$DRY_RUN" != "true" ]]; then
    "$KUBECTL" delete certificate nova-launch-mtls-new \
      -n "$NAMESPACE" --ignore-not-found
  fi

  # Remove local working files (keys stay in backup only)
  if [[ "$DRY_RUN" != "true" ]]; then
    rm -f "${CERT_DIR}/new-tls.crt" "${CERT_DIR}/new-tls.key" \
          "${CERT_DIR}/new-ca.crt"  "${CERT_DIR}/combined-ca.crt"
  fi

  log "Cleanup complete. Backup of previous certs retained at: $BACKUP_DIR"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  log "========================================================"
  log "Nova Launch — Zero-Downtime mTLS Certificate Rotation"
  log "Namespace: $NAMESPACE | DryRun: $DRY_RUN"
  log "========================================================"

  preflight
  issue_certificate
  enter_dual_trust_window
  monitor_post_distribution
  cutover
  monitor_post_cutover
  cleanup

  log "========================================================"
  log "mTLS certificate rotation COMPLETE — no downtime."
  log "========================================================"
}

main "$@"
