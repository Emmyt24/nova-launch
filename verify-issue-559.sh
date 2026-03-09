#!/bin/bash

echo "=========================================="
echo "Issue #559 Implementation Verification"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

check_file() {
    if [ -f "$1" ]; then
        echo -e "${GREEN}✓${NC} $1"
        return 0
    else
        echo -e "${RED}✗${NC} $1 (MISSING)"
        return 1
    fi
}

echo "Checking Smart Contract Files..."
check_file "contracts/token-factory/src/buyback.rs"

echo ""
echo "Checking Backend Files..."
check_file "backend/src/routes/buyback.ts"
check_file "backend/src/routes/__tests__/buyback.test.ts"

echo ""
echo "Checking Frontend Files..."
check_file "frontend/src/components/BuybackCampaign/ExecuteStepButton.tsx"
check_file "frontend/src/components/BuybackCampaign/CampaignDashboard.tsx"
check_file "frontend/src/components/BuybackCampaign/index.ts"
check_file "frontend/src/components/BuybackCampaign/__tests__/ExecuteStepButton.test.tsx"
check_file "frontend/src/components/BuybackCampaign/__tests__/CampaignDashboard.test.tsx"
check_file "frontend/src/hooks/useStellar.ts"

echo ""
echo "Checking Documentation..."
check_file "BUYBACK_CAMPAIGN_IMPLEMENTATION.txt"
check_file "BUYBACK_QUICK_REF.txt"
check_file "IMPLEMENTATION_SUMMARY.txt"

echo ""
echo "Checking Modified Files..."
grep -q "mod buyback" contracts/token-factory/src/lib.rs && echo -e "${GREEN}✓${NC} lib.rs includes buyback module" || echo -e "${RED}✗${NC} lib.rs missing buyback module"
grep -q "BuybackCampaign" contracts/token-factory/src/types.rs && echo -e "${GREEN}✓${NC} types.rs includes BuybackCampaign" || echo -e "${RED}✗${NC} types.rs missing BuybackCampaign"
grep -q "get_buyback_campaign" contracts/token-factory/src/storage.rs && echo -e "${GREEN}✓${NC} storage.rs includes buyback functions" || echo -e "${RED}✗${NC} storage.rs missing buyback functions"
grep -q "emit_campaign_created" contracts/token-factory/src/events.rs && echo -e "${GREEN}✓${NC} events.rs includes campaign events" || echo -e "${RED}✗${NC} events.rs missing campaign events"
grep -q "buybackRoutes" backend/src/index.ts && echo -e "${GREEN}✓${NC} index.ts includes buyback routes" || echo -e "${RED}✗${NC} index.ts missing buyback routes"
grep -q "BuybackCampaign" backend/prisma/schema.prisma && echo -e "${GREEN}✓${NC} schema.prisma includes BuybackCampaign model" || echo -e "${RED}✗${NC} schema.prisma missing BuybackCampaign model"
grep -q "executeBuybackStep" frontend/src/services/stellar.service.ts && echo -e "${GREEN}✓${NC} stellar.service.ts includes executeBuybackStep" || echo -e "${RED}✗${NC} stellar.service.ts missing executeBuybackStep"

echo ""
echo "=========================================="
echo "Verification Complete!"
echo "=========================================="
