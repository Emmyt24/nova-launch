#!/bin/bash

# Campaign Consistency Checker Test Runner

set -e

echo "🔍 Campaign Consistency Checker Test Suite"
echo "=========================================="
echo ""

if [ ! -f "package.json" ]; then
    echo "❌ Error: Must be run from backend directory"
    exit 1
fi

echo "🧪 Running Consistency Checker Tests..."
npm test -- campaignConsistencyChecker.test.ts --run
echo "✅ Consistency Checker Tests Complete"
echo ""

echo "🧪 Running Fixture Scenario Tests..."
npm test -- campaignConsistencyFixtures.test.ts --run
echo "✅ Fixture Tests Complete"
echo ""

echo "🧪 Running Randomized Trace Tests..."
npm test -- campaignConsistencyRandomized.test.ts --run
echo "✅ Randomized Tests Complete"
echo ""

echo "=========================================="
echo "✅ All Consistency Tests Passed!"
echo ""
echo "Verification Complete:"
echo "  ✅ Backend aggregates match on-chain values"
echo "  ✅ Fixture scenarios verified"
echo "  ✅ Randomized execution traces verified"
echo "  ✅ No consistency drift detected"
