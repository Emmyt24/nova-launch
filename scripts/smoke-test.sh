#!/bin/bash
# Smoke Test Script for Contract Upgrades
# Runs basic tests to verify contract functionality

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONTRACT_ID=$1
NETWORK=${2:-testnet}
ADMIN_KEY=${3:-admin}

if [ -z "$CONTRACT_ID" ]; then
    echo -e "${RED}Error: Contract ID required${NC}"
    echo "Usage: $0 <contract_id> [network] [admin_key]"
    exit 1
fi

echo -e "${GREEN}=== Contract Smoke Tests ===${NC}"
echo "Contract: $CONTRACT_ID"
echo "Network: $NETWORK"
echo ""
echo -e "${YELLOW}Tip: For a full-stack smoke test (chain + backend + API), run:${NC}"
echo "  ./scripts/fullstack-smoke-test.sh --network $NETWORK"
echo ""

PASSED=0
FAILED=0

# Test 1: Get State
echo -e "${YELLOW}Test 1: Get State${NC}"
if STATE=$(soroban contract invoke --id "$CONTRACT_ID" --network "$NETWORK" -- get_state 2>&1); then
    echo -e "${GREEN}✓ get_state() works${NC}"
    echo "$STATE" | jq '.'
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗ get_state() failed${NC}"
    FAILED=$((FAILED + 1))
fi

# Extract admin for subsequent tests
ADMIN=$(echo "$STATE" | jq -r '.admin' 2>/dev/null || echo "")

# Test 2: Update Fees
echo -e "\n${YELLOW}Test 2: Update Fees${NC}"
if soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --source "$ADMIN_KEY" \
    -- update_fees \
    --admin "$ADMIN" \
    --base_fee 80000000 \
    --metadata_fee 35000000 2>&1 >/dev/null; then
    echo -e "${GREEN}✓ update_fees() works${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗ update_fees() failed${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 3: Pause
echo -e "\n${YELLOW}Test 3: Pause Contract${NC}"
if soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --source "$ADMIN_KEY" \
    -- pause \
    --admin "$ADMIN" 2>&1 >/dev/null; then
    echo -e "${GREEN}✓ pause() works${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗ pause() failed${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 4: Unpause
echo -e "\n${YELLOW}Test 4: Unpause Contract${NC}"
if soroban contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --source "$ADMIN_KEY" \
    -- unpause \
    --admin "$ADMIN" 2>&1 >/dev/null; then
    echo -e "${GREEN}✓ unpause() works${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}✗ unpause() failed${NC}"
    FAILED=$((FAILED + 1))
fi

# Test 5: State Consistency
echo -e "\n${YELLOW}Test 5: State Consistency${NC}"
if FINAL_STATE=$(soroban contract invoke --id "$CONTRACT_ID" --network "$NETWORK" -- get_state 2>&1); then
    PAUSED=$(echo "$FINAL_STATE" | jq -r '.paused')
    BASE_FEE=$(echo "$FINAL_STATE" | jq -r '.base_fee')
    
    if [ "$PAUSED" = "false" ] && [ "$BASE_FEE" = "80000000" ]; then
        echo -e "${GREEN}✓ State is consistent${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}✗ State inconsistency detected${NC}"
        echo "Paused: $PAUSED (expected: false)"
        echo "Base Fee: $BASE_FEE (expected: 80000000)"
        FAILED=$((FAILED + 1))
    fi
else
    echo -e "${RED}✗ Could not verify state${NC}"
    FAILED=$((FAILED + 1))
fi

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Total: $((PASSED + FAILED))"

if [ $FAILED -eq 0 ]; then
    echo -e "\n${GREEN}✓ All smoke tests passed${NC}"
    exit 0
else
    echo -e "\n${RED}✗ Some tests failed${NC}"
    exit 1
fi
