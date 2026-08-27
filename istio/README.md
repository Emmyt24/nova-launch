# Nova Launch — Istio Service Mesh
#
# Apply order:
#   1. namespace.yaml          — create namespace + enable sidecar injection
#   2. deployments.yaml        — workloads (backend, frontend, gateway)
#   3. services.yaml           — ClusterIP services
#   4. gateway.yaml            — Istio IngressGateway
#   5. virtual-services.yaml   — routing rules
#   6. destination-rules.yaml  — traffic policies (mTLS, circuit breaker)
#   7. peer-authentication.yaml — enforce STRICT mTLS mesh-wide
#
# Quick start:
#   kubectl apply -f istio/
#
# Prerequisites:
#   - Kubernetes 1.27+
#   - Istio 1.20+ installed (istioctl install --set profile=default)
#   - Secrets created (see README section below)
#
# Secrets required before applying:
#   kubectl create secret generic nova-launch-secrets \
#     --from-literal=DATABASE_URL='postgresql://...' \
#     --from-literal=JWT_SECRET='...' \
#     --from-literal=ADMIN_JWT_SECRET='...' \
#     -n nova-launch
#
# mTLS STRICT verification (#1616):
#   Two layers, both run by scripts/verify-istio-mtls-strict.sh:
#     1. Config-lint (always runs) — istio/__tests__/manifests.test.js
#        asserts every PeerAuthentication resource is STRICT except the
#        documented redis-permissive exemption. This catches a policy edit
#        that silently downgrades to PERMISSIVE before it ever reaches a
#        cluster.
#     2. Live check (runs only when kubectl has access to a real cluster
#        with the nova-launch namespace) — launches a probe pod with
#        sidecar injection disabled so its traffic is genuine plaintext,
#        then attempts a plaintext HTTP request to the backend Service.
#        Under STRICT mode the connection must be rejected by the
#        receiving sidecar, not merely "claimed STRICT" in YAML. When no
#        cluster is reachable this step is skipped with an explicit
#        message — it is never silently no-op'd.
#
#   Re-run after any change to peer-authentication.yaml or destination-rules.yaml:
#     ./scripts/verify-istio-mtls-strict.sh
#
#   Config-lint only (no cluster needed):
#     cd istio && npm test
