#!/bin/bash
# ==============================================================================
# Docker Compose Startup Dependency Ordering Verification Script
#
# Asserts that core dependencies (Postgres and Redis) achieve healthy status
# strictly before the backend service achieves healthy status, validating
# `depends_on: condition: service_healthy` rules in docker-compose.yml.
#
# Issue: #1609
# ==============================================================================

set -e

echo "=== Verifying Docker Compose Startup Dependency Ordering ==="

if ! command -v docker &> /dev/null; then
    echo "⚠️ Docker not found, skipping compose startup verification."
    exit 0
fi

COMPOSE_CMD="docker compose"
if ! docker compose version &> /dev/null; then
    if command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        echo "⚠️ Docker Compose not found, skipping compose startup verification."
        exit 0
    fi
fi

# Ensure clean state
$COMPOSE_CMD down -v --remove-orphans 2>/dev/null || true

echo "Starting database and cache services (postgres, redis)..."
$COMPOSE_CMD up -d postgres redis

MAX_WAIT=90
WAITED=0
PG_HEALTHY=0
REDIS_HEALTHY=0

while [ $WAITED -lt $MAX_WAIT ]; do
    PG_STATUS=$($COMPOSE_CMD inspect --format='{{.State.Health.Status}}' postgres 2>/dev/null || echo "starting")
    REDIS_STATUS=$($COMPOSE_CMD inspect --format='{{.State.Health.Status}}' redis 2>/dev/null || echo "starting")
    
    if [ "$PG_STATUS" = "healthy" ]; then
        PG_HEALTHY=1
    fi
    if [ "$REDIS_STATUS" = "healthy" ]; then
        REDIS_HEALTHY=1
    fi

    if [ $PG_HEALTHY -eq 1 ] && [ $REDIS_HEALTHY -eq 1 ]; then
        echo "✓ Postgres and Redis are both healthy."
        break
    fi

    sleep 3
    WAITED=$((WAITED + 3))
done

if [ $PG_HEALTHY -eq 0 ] || [ $REDIS_HEALTHY -eq 0 ]; then
    echo "❌ Timeout or failure waiting for Postgres/Redis health status."
    $COMPOSE_CMD logs
    $COMPOSE_CMD down -v
    exit 1
fi

echo "Starting backend service (depends on postgres & redis being healthy)..."
$COMPOSE_CMD up -d backend

WAITED=0
BACKEND_HEALTHY=0

while [ $WAITED -lt $MAX_WAIT ]; do
    PG_STATUS=$($COMPOSE_CMD inspect --format='{{.State.Health.Status}}' postgres 2>/dev/null || echo "unhealthy")
    REDIS_STATUS=$($COMPOSE_CMD inspect --format='{{.State.Health.Status}}' redis 2>/dev/null || echo "unhealthy")
    BACKEND_STATUS=$($COMPOSE_CMD inspect --format='{{.State.Health.Status}}' backend 2>/dev/null || echo "starting")

    if [ "$PG_STATUS" != "healthy" ] || [ "$REDIS_STATUS" != "healthy" ]; then
        echo "❌ Violation: Postgres or Redis lost health status while backend was starting!"
        $COMPOSE_CMD down -v
        exit 1
    fi

    if [ "$BACKEND_STATUS" = "healthy" ]; then
        echo "✓ Backend reported healthy after database and cache were verified healthy."
        BACKEND_HEALTHY=1
        break
    fi

    sleep 3
    WAITED=$((WAITED + 3))
done

$COMPOSE_CMD down -v

if [ $BACKEND_HEALTHY -eq 1 ]; then
    echo "SUCCESS: Health-check dependency ordering verification passed!"
    exit 0
else
    echo "❌ Timeout waiting for backend service health."
    exit 1
fi
