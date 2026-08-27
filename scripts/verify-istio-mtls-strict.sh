#!/usr/bin/env bash
# verify-istio-mtls-strict.sh
#
# Verifies that Istio mTLS is actually enforced in STRICT mode for the
# nova-launch namespace, not just declared as STRICT in the YAML:
#
#   1. Config-lint — runs the istio manifest test suite (istio/__tests__),
#      which asserts every PeerAuthentication resource is STRICT except the
#      documented Redis exemption.
#   2. Live check (only runs if a cluster is reachable) — launches a pod
#      with sidecar injection disabled (so its traffic is genuine plaintext,
#      not mesh mTLS) and attempts a plaintext HTTP connection to the
#      backend Service. Under STRICT mode this connection MUST be rejected
#      by the receiving sidecar. If no cluster is reachable, this step is
#      skipped with an explicit message — never silently.
#
# Usage: ./scripts/verify-istio-mtls-strict.sh
#
# See istio/README.md for the full verification approach and instructions
# for re-running this after any PeerAuthentication / DestinationRule change.

set -euo pipefail

ISTIO_DIR="$(cd "$(dirname "$0")/../istio" && pwd)"
NAMESPACE="nova-launch"
BACKEND_HOST="backend.${NAMESPACE}.svc.cluster.local"
PROBE_POD="mtls-plaintext-probe-$$"

echo "==> [1/2] Config-lint: asserting PeerAuthentication STRICT mode in manifests..."
(cd "$ISTIO_DIR" && npm test) || {
  echo "Config-lint FAILED: PeerAuthentication manifests do not assert STRICT mTLS as expected." >&2
  exit 1
}
echo "==> Config-lint passed: STRICT mTLS is declared mesh-wide (Redis exempted)."
echo ""

echo "==> [2/2] Live plaintext-rejection check..."

if ! command -v kubectl >/dev/null 2>&1; then
  echo "SKIPPED: kubectl not found — this step requires a live cluster and is not run in this environment."
  echo "         Run this script from an environment with cluster access to exercise it; see istio/README.md."
  exit 0
fi

if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "SKIPPED: namespace '$NAMESPACE' not found on the current kubectl context — no live cluster to test against."
  echo "         See istio/README.md for how to run this check against a real cluster."
  exit 0
fi

cleanup() {
  kubectl delete pod "$PROBE_POD" -n "$NAMESPACE" --ignore-not-found --now >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "    Launching plaintext probe pod ($PROBE_POD, sidecar injection disabled)..."
kubectl run "$PROBE_POD" \
  -n "$NAMESPACE" \
  --image=curlimages/curl:8.9.1 \
  --restart=Never \
  --annotations="sidecar.istio.io/inject=false" \
  --command -- sleep 60 >/dev/null

kubectl wait --for=condition=Ready "pod/$PROBE_POD" -n "$NAMESPACE" --timeout=30s >/dev/null

set +e
kubectl exec "$PROBE_POD" -n "$NAMESPACE" -- \
  curl --http1.1 --max-time 5 -sS -o /dev/null -w '%{http_code}' "http://${BACKEND_HOST}:3001/health"
CURL_EXIT=$?
set -e

if [ "$CURL_EXIT" -eq 0 ]; then
  echo "FAILED: plaintext connection to backend SUCCEEDED — STRICT mTLS is not being enforced!" >&2
  exit 1
fi

echo "==> Live check passed: plaintext connection was rejected (curl exit code $CURL_EXIT, non-zero = refused/reset)."
echo ""
echo "==> mTLS STRICT enforcement verified: config declares STRICT and a live plaintext probe is rejected."
