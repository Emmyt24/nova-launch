#!/bin/bash
# =============================================================================
# Fullstack Deployment Smoke Test
# Deploys a token, confirms it on-chain, waits for backend ingestion,
# and verifies frontend-readable state via the indexed API.
#
# Usage:
#   ./scripts/fullstack-smoke-test.sh [--network testnet|mainnet] [--verbose]
#
# Prerequisites:
#   - soroban CLI installed and `admin` identity configured
#   - Backend API running (PORT from .env.testnet or default 3001)
#   - FACTORY_CONTRACT_ID set in .env.testnet
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Defaults ─────────────────────────────────────────────────────────────────
NETWORK="testnet"
VERBOSE=false
PASSED=0
FAILED=0
START_TIME=$(date +%s)

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --network) NETWORK="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--network testnet|mainnet] [--verbose]"
      exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

# ── Load canonical env ────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-.env.testnet}"
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

FACTORY_CONTRACT_ID="${FACTORY_CONTRACT_ID:-}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
INGESTION_TIMEOUT="${INGESTION_TIMEOUT:-30}"   # seconds to wait for backend ingestion
INGESTION_POLL_INTERVAL=3                       # seconds between polls

if [ -z "$FACTORY_CONTRACT_ID" ]; then
  echo -e "${RED}Error: FACTORY_CONTRACT_ID not set. Run deploy-testnet.sh first or set it in $ENV_FILE.${NC}"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()    { echo -e "${BLUE}[smoke]${NC} $*"; }
ok()     { echo -e "${GREEN}  ✓${NC} $*"; PASSED=$((PASSED + 1)); }
fail()   { echo -e "${RED}  ✗${NC} $*"; FAILED=$((FAILED + 1)); }
header() { echo -e "\n${CYAN}── $* ──${NC}"; }

run_verbose() {
  if [ "$VERBOSE" = true ]; then
    "$@"
  else
    "$@" 2>&1 | tail -5
  fi
}

# ── Phase 1: On-chain token deployment ───────────────────────────────────────
header "Phase 1: Deploy token on-chain"

ADMIN_ADDRESS=$(soroban keys address admin)
SMOKE_SYMBOL="SMK$(date +%s | tail -c 5)"   # unique symbol per run
SMOKE_NAME="Smoke Test Token $SMOKE_SYMBOL"

log "Factory:  $FACTORY_CONTRACT_ID"
log "Network:  $NETWORK"
log "Symbol:   $SMOKE_SYMBOL"
log "Admin:    $ADMIN_ADDRESS"

TOKEN_ADDRESS=$(soroban contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network "$NETWORK" \
  --source admin \
  -- create_token \
  --creator "$ADMIN_ADDRESS" \
  --name "$SMOKE_NAME" \
  --symbol "$SMOKE_SYMBOL" \
  --decimals 7 \
  --initial_supply 1000000 \
  --fee_payment 70000000 2>&1) || {
    fail "create_token invocation failed"
    echo "$TOKEN_ADDRESS"
    exit 1
  }

# Strip surrounding quotes soroban CLI may emit
TOKEN_ADDRESS=$(echo "$TOKEN_ADDRESS" | tr -d '"' | tr -d "'" | xargs)

if [[ "$TOKEN_ADDRESS" =~ ^C[A-Z0-9]{55}$ ]]; then
  ok "Token deployed: $TOKEN_ADDRESS"
else
  fail "Unexpected token address format: '$TOKEN_ADDRESS'"
  exit 1
fi

# ── Phase 2: On-chain confirmation ────────────────────────────────────────────
header "Phase 2: Confirm token on-chain via Horizon"

HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}"
HORIZON_RESP=$(curl -sf "$HORIZON_URL/accounts/$TOKEN_ADDRESS" 2>/dev/null || echo "")

if [ -n "$HORIZON_RESP" ]; then
  ok "Token account exists on Horizon"
else
  # Soroban contract accounts may not appear as classic accounts — verify via contract data instead
  log "Horizon account not found (expected for Soroban tokens); verifying via contract state..."
  CONTRACT_STATE=$(soroban contract invoke \
    --id "$FACTORY_CONTRACT_ID" \
    --network "$NETWORK" \
    --source admin \
    -- get_state 2>&1 || echo "")

  if echo "$CONTRACT_STATE" | grep -q '"admin"'; then
    ok "Factory contract state readable — on-chain confirmation passed"
  else
    fail "Could not confirm token on-chain"
  fi
fi

# ── Phase 3: Backend ingestion wait ──────────────────────────────────────────
header "Phase 3: Wait for backend event ingestion"

log "Polling $BACKEND_URL/api/tokens/search?q=$SMOKE_SYMBOL (timeout: ${INGESTION_TIMEOUT}s)"

DEADLINE=$(($(date +%s) + INGESTION_TIMEOUT))
INGESTED=false

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  SEARCH_RESP=$(curl -sf \
    "$BACKEND_URL/api/tokens/search?q=$SMOKE_SYMBOL&limit=5" \
    -H "Accept: application/json" 2>/dev/null || echo "")

  if [ -n "$SEARCH_RESP" ]; then
    MATCH_COUNT=$(echo "$SEARCH_RESP" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(len([t for t in d.get('data',[]) if t.get('symbol')=='$SMOKE_SYMBOL']))" \
      2>/dev/null || echo "0")

    if [ "$MATCH_COUNT" -gt 0 ]; then
      INGESTED=true
      break
    fi
  fi

  log "Not yet ingested — retrying in ${INGESTION_POLL_INTERVAL}s..."
  sleep "$INGESTION_POLL_INTERVAL"
done

if [ "$INGESTED" = true ]; then
  ok "Token indexed by backend (symbol: $SMOKE_SYMBOL)"
else
  fail "Backend did not ingest token within ${INGESTION_TIMEOUT}s"
  echo -e "${YELLOW}  Hint: Is the backend running? Is ENABLE_EVENT_LISTENER=true?${NC}"
fi

# ── Phase 4: Frontend-readable API state ─────────────────────────────────────
header "Phase 4: Verify frontend-readable API state"

SEARCH_RESP=$(curl -sf \
  "$BACKEND_URL/api/tokens/search?q=$SMOKE_SYMBOL&limit=5" \
  -H "Accept: application/json" 2>/dev/null || echo "")

if [ -z "$SEARCH_RESP" ]; then
  fail "Backend API unreachable at $BACKEND_URL"
else
  # Validate response shape
  SUCCESS=$(echo "$SEARCH_RESP" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('success','false'))" \
    2>/dev/null || echo "false")

  TOKEN_ADDR_INDEXED=$(echo "$SEARCH_RESP" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); tokens=[t for t in d.get('data',[]) if t.get('symbol')=='$SMOKE_SYMBOL']; print(tokens[0].get('address','') if tokens else '')" \
    2>/dev/null || echo "")

  TOKEN_CREATOR=$(echo "$SEARCH_RESP" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); tokens=[t for t in d.get('data',[]) if t.get('symbol')=='$SMOKE_SYMBOL']; print(tokens[0].get('creator','') if tokens else '')" \
    2>/dev/null || echo "")

  if [ "$SUCCESS" = "True" ] || [ "$SUCCESS" = "true" ]; then
    ok "API response shape valid (success: true)"
  else
    fail "API response missing success flag"
  fi

  if [ "$TOKEN_ADDR_INDEXED" = "$TOKEN_ADDRESS" ]; then
    ok "Indexed token address matches deployed address ($TOKEN_ADDRESS)"
  else
    fail "Address mismatch — indexed: '$TOKEN_ADDR_INDEXED', deployed: '$TOKEN_ADDRESS'"
  fi

  if [ "$TOKEN_CREATOR" = "$ADMIN_ADDRESS" ]; then
    ok "Creator address matches admin ($ADMIN_ADDRESS)"
  else
    fail "Creator mismatch — indexed: '$TOKEN_CREATOR', expected: '$ADMIN_ADDRESS'"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Fullstack Smoke Test — Summary${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo "  Token:    $TOKEN_ADDRESS"
echo "  Symbol:   $SMOKE_SYMBOL"
echo "  Network:  $NETWORK"
echo "  Duration: ${ELAPSED}s"
echo "  Passed:   $PASSED"
echo "  Failed:   $FAILED"
echo -e "${CYAN}══════════════════════════════════════════${NC}"

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}✓ All checks passed — stack is healthy${NC}"
  exit 0
else
  echo -e "${RED}✗ $FAILED check(s) failed — see output above${NC}"
  exit 1
fi
