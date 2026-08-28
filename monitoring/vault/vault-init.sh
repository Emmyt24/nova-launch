#!/bin/bash
# =============================================================================
# Vault Initialisation & Secret Seeding Script — Nova Launch
# Issue: #896
#
# Run once after first `vault server` start to:
#   1. Initialise Vault (generates unseal keys + root token)
#   2. Unseal Vault
#   3. Enable KV-v2 secrets engine
#   4. Seed Nova Launch application secrets
#   5. Create a scoped AppRole for the backend service
#
# Environment variables:
#   VAULT_ADDR              — Vault address (default: http://127.0.0.1:8200)
#   VAULT_KEYS_FILE         — Path to init keys JSON (default: /vault/init-keys.json)
#   SECRET_ID_TTL           — AppRole SecretID TTL (default: 768h)
#   SECRET_ID_NUM_USES      — Max uses per SecretID (default: 10)
# =============================================================================
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_KEYS_FILE="${VAULT_KEYS_FILE:-/vault/init-keys.json}"
SECRET_ID_TTL="${SECRET_ID_TTL:-768h}"
SECRET_ID_NUM_USES="${SECRET_ID_NUM_USES:-10}"
NOVA_POLICY_NAME="nova-launch-backend"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[vault-init]${NC} $*"; }
success() { echo -e "${GREEN}[vault-init] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[vault-init] ⚠${NC} $*"; }
error()   { echo -e "${RED}[vault-init] ✗${NC} $*" >&2; }

export VAULT_ADDR

# ── Wait for Vault to be reachable ───────────────────────────────────────────
wait_for_vault() {
  log "Waiting for Vault at ${VAULT_ADDR}..."
  local retries=0
  until curl -sf "${VAULT_ADDR}/v1/sys/health" > /dev/null 2>&1 || [[ $retries -ge 30 ]]; do
    sleep 2
    retries=$(( retries + 1 ))
  done
  success "Vault is reachable"
}

# ── Initialise ────────────────────────────────────────────────────────────────
init_vault() {
  local status
  status=$(curl -sf "${VAULT_ADDR}/v1/sys/init" | grep -o '"initialized":[^,}]*' | cut -d: -f2 | tr -d ' ')

  if [[ "$status" == "true" ]]; then
    warn "Vault already initialised — skipping init"
    return 0
  fi

  log "Initialising Vault (5 key shares, threshold 3)..."
  vault operator init \
    -key-shares=5 \
    -key-threshold=3 \
    -format=json > "$VAULT_KEYS_FILE"

  chmod 600 "$VAULT_KEYS_FILE"
  success "Vault initialised. Keys saved to ${VAULT_KEYS_FILE}"
  warn "IMPORTANT: Store unseal keys and root token securely and delete ${VAULT_KEYS_FILE}"
}

# ── Unseal ────────────────────────────────────────────────────────────────────
unseal_vault() {
  local sealed
  sealed=$(curl -sf "${VAULT_ADDR}/v1/sys/seal-status" | grep -o '"sealed":[^,}]*' | cut -d: -f2 | tr -d ' ')

  if [[ "$sealed" == "false" ]]; then
    warn "Vault already unsealed"
    return 0
  fi

  if [[ ! -f "$VAULT_KEYS_FILE" ]]; then
    error "Keys file not found: ${VAULT_KEYS_FILE}"
    exit 1
  fi

  log "Unsealing Vault..."
  for i in 0 1 2; do
    local key
    key=$(python3 -c "import json,sys; d=json.load(open('${VAULT_KEYS_FILE}')); print(d['unseal_keys_b64'][${i}])" 2>/dev/null || \
          node -e "const d=require('${VAULT_KEYS_FILE}'); console.log(d.unseal_keys_b64[${i}])" 2>/dev/null)
    vault operator unseal "$key"
  done
  success "Vault unsealed"
}

# ── Authenticate with root token ──────────────────────────────────────────────
auth_root() {
  local root_token
  root_token=$(python3 -c "import json; d=json.load(open('${VAULT_KEYS_FILE}')); print(d['root_token'])" 2>/dev/null || \
               node -e "const d=require('${VAULT_KEYS_FILE}'); console.log(d.root_token)" 2>/dev/null)
  export VAULT_TOKEN="$root_token"
  success "Authenticated with root token"
}

# ── Enable KV-v2 secrets engine ───────────────────────────────────────────────
enable_kv() {
  if vault secrets list -format=json | grep -q '"nova/"'; then
    warn "KV engine at nova/ already enabled"
    return 0
  fi
  log "Enabling KV-v2 secrets engine at nova/..."
  vault secrets enable -path=nova -version=2 kv
  success "KV-v2 enabled at nova/"
}

# ── Seed application secrets ──────────────────────────────────────────────────
seed_secrets() {
  log "Seeding Nova Launch application secrets..."

  # Backend secrets
  vault kv put nova/backend \
    JWT_SECRET="$(openssl rand -base64 64)" \
    ADMIN_JWT_SECRET="$(openssl rand -base64 64)" \
    DATABASE_URL="${DATABASE_URL:-postgresql://nova_user:nova_password@postgres:5432/nova_launch}" \
    REDIS_URL="${REDIS_URL:-redis://redis:6379}"

  # Stellar network secrets
  vault kv put nova/stellar \
    STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}" \
    STELLAR_HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}" \
    FACTORY_CONTRACT_ID="${FACTORY_CONTRACT_ID:-}"

  # Observability secrets
  vault kv put nova/observability \
    SENTRY_DSN="${SENTRY_DSN:-}" \
    ELASTICSEARCH_PASSWORD="${ELASTICSEARCH_PASSWORD:-changeme}"

  success "Secrets seeded"
}

# ── Create backend policy ─────────────────────────────────────────────────────
create_policy() {
  log "Creating backend access policy: ${NOVA_POLICY_NAME}..."
  vault policy write "$NOVA_POLICY_NAME" - <<'EOF'
# Nova Launch Backend — read-only access to application secrets
path "nova/data/backend" {
  capabilities = ["read"]
}
path "nova/data/stellar" {
  capabilities = ["read"]
}
path "nova/data/observability" {
  capabilities = ["read"]
}
# Allow token renewal
path "auth/token/renew-self" {
  capabilities = ["update"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
EOF
  success "Policy created: ${NOVA_POLICY_NAME}"
}

# ── Enable AppRole auth & create role ────────────────────────────────────────
create_approle() {
  if ! vault auth list -format=json | grep -q '"approle/"'; then
    log "Enabling AppRole auth method..."
    vault auth enable approle
  fi

  log "Creating AppRole: nova-backend..."
  vault write auth/approle/role/nova-backend \
    token_policies="${NOVA_POLICY_NAME}" \
    token_ttl=1h \
    token_max_ttl=4h \
    secret_id_ttl="${SECRET_ID_TTL}" \
    secret_id_num_uses="${SECRET_ID_NUM_USES}"

  local role_id secret_id
  role_id=$(vault read -field=role_id auth/approle/role/nova-backend/role-id)
  secret_id=$(vault write -f -field=secret_id auth/approle/role/nova-backend/secret-id)

  success "AppRole created"
  log "  VAULT_ROLE_ID=${role_id}"
  log "  VAULT_SECRET_ID=${secret_id}"
  warn "VAULT_SECRET_ID expires after ${SECRET_ID_TTL} or ${SECRET_ID_NUM_USES} uses — rotate before either limit"

  # Save for CI/CD use
  cat > /tmp/nova-approle-credentials.json <<EOF
{
  "role_id": "${role_id}",
  "secret_id": "${secret_id}",
  "vault_addr": "${VAULT_ADDR}"
}
EOF
  chmod 600 /tmp/nova-approle-credentials.json
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  wait_for_vault
  init_vault
  unseal_vault
  auth_root
  enable_kv
  seed_secrets
  create_policy
  create_approle
  success "Vault initialisation complete"
}

main "$@"
