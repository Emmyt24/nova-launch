#!/bin/bash

# Campaign Chaos Testing Runner

set -e

echo "💥 Campaign Chaos Testing Suite"
echo "================================"
echo ""

if [ ! -f "package.json" ]; then
    echo "❌ Error: Must be run from backend directory"
    exit 1
fi

echo "🧪 Running Chaos Tests with Reproducible Seeds..."
npm test -- campaignChaos.test.ts --run
echo "✅ Chaos Tests Complete"
echo ""

echo "================================"
echo "✅ All Chaos Tests Passed!"
echo ""
echo "Resilience Verified:"
echo "  ✅ Interleaved concurrent campaigns"
echo "  ✅ Indexer lag recovery"
echo "  ✅ Duplicate event handling"
echo "  ✅ Backend outage recovery"
echo "  ✅ Retry storm resilience"
echo "  ✅ Combined fault scenarios"
echo "  ✅ Eventual consistency maintained"
