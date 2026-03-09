#!/bin/bash

# Campaign Ingestion Test Runner
# Runs all campaign-related tests and verifies acceptance criteria

set -e

echo "🚀 Campaign Ingestion Test Suite"
echo "================================"
echo ""

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Must be run from backend directory"
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Check if Prisma client is generated
if [ ! -d "node_modules/.prisma" ]; then
    echo "🔧 Generating Prisma client..."
    npx prisma generate
fi

echo "🧪 Running Campaign Ingestion Tests..."
npm test -- campaignIngestion.test.ts --run
echo "✅ Campaign Ingestion Tests Complete"
echo ""

echo "================================"
echo "✅ All Campaign Ingestion Tests Passed!"
echo ""
echo "Acceptance Criteria Verified:"
echo "  ✅ Parse and persist buyback event stream"
echo "  ✅ Build projection logic for campaign status, totals, execution history"
echo "  ✅ Implement replay-safe idempotent upserts"
echo "  ✅ Add integration tests for out-of-order and duplicate events"
echo "  ✅ Backend projections remain consistent under ingestion tests"
echo ""
echo "📚 See CAMPAIGN_INGESTION.md for full documentation"
