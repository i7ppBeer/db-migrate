#!/bin/bash
# ============================================================
# Local Migration Test Script
# Up -> Down -> Up against a real database via the real docker-compose.yml
# ============================================================
#
# Rewritten 2026-09-29: the previous version of this script hardcoded
# COMPOSE_FILE="docker-compose.local-test.yml" and service names
# (migration/migration-auth/migration-mariadb) that never existed anywhere
# in this repo — running it failed immediately with "no configuration file
# provided". docs/LOCAL-TEST-GUIDE.md carried a warning about this since a
# 2026-09-11 audit; this rewrite is the fix rather than another rewording of
# the warning. It now drives the real docker-compose.yml's `mongodb`/
# `mariadb` services and the generic `migrate` service (profile: tools),
# pointed at the test-success fixtures. The mongodb-auth variant is dropped —
# docker-compose.yml has no service for it; add one there first if you need it.
#
# Usage:
#   ./scripts/local-test.sh [options]
#
# Options:
#   -d, --db        Database type: mongodb, mariadb (default: mongodb)
#   -c, --clean     Stop and remove containers/volumes after the test
#   -h, --help      Show help
#
# Examples:
#   ./scripts/local-test.sh
#   ./scripts/local-test.sh -d mariadb
#   ./scripts/local-test.sh -d mariadb --clean
#
# ============================================================

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Default values
DB_TYPE="mongodb"
CLEAN_UP=false
COMPOSE_FILE="docker-compose.yml"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -d|--db)
            DB_TYPE="$2"
            shift 2
            ;;
        -c|--clean)
            CLEAN_UP=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  -d, --db        Database type: mongodb, mariadb (default: mongodb)"
            echo "  -c, --clean     Stop and remove containers/volumes after the test"
            echo "  -h, --help      Show help"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Determine DB service + a real test-success fixture config to run against
case $DB_TYPE in
    mongodb)
        DB_SERVICE="mongodb"
        CONFIG="/app/test-fixtures/mongodb/test-success/ddl/config.js"
        ;;
    mariadb)
        DB_SERVICE="mariadb"
        CONFIG="/app/test-fixtures/mariadb/test-success/ddl/config.js"
        ;;
    *)
        echo -e "${RED}Unknown database type: $DB_TYPE${NC}"
        echo "Supported: mongodb, mariadb"
        exit 1
        ;;
esac

run_migrate() {
    docker compose -f "$COMPOSE_FILE" --profile tools run --rm migrate "$@" -c "$CONFIG"
}

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Local Migration Test                                  ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Compose file:   $COMPOSE_FILE"
echo "  Database Type:  $DB_TYPE"
echo "  DB Service:     $DB_SERVICE"
echo "  Config:         $CONFIG"
echo ""

# ============================================================
# Step 1: Start Database
# ============================================================
echo -e "${CYAN}[STEP 1/6] Starting database ($DB_SERVICE)...${NC}"
docker compose -f "$COMPOSE_FILE" up -d "$DB_SERVICE"

echo "Waiting for database to be healthy..."
attempt=0
until docker compose -f "$COMPOSE_FILE" ps "$DB_SERVICE" | grep -q "healthy"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo -e "${RED}[FAIL] Database did not become healthy in time.${NC}"
        docker compose -f "$COMPOSE_FILE" logs "$DB_SERVICE" --tail 50
        exit 1
    fi
    sleep 2
done

echo -e "${GREEN}[OK] Database is ready!${NC}"
echo ""

# ============================================================
# Step 2: Check Migration Status (Before)
# ============================================================
echo -e "${CYAN}[STEP 2/6] Checking migration status (before)...${NC}"
run_migrate status || true
echo ""

# ============================================================
# Step 3: Run UP
# ============================================================
echo -e "${CYAN}[STEP 3/6] Running migrations UP...${NC}"
run_migrate up
echo -e "${GREEN}[OK] UP completed successfully!${NC}"
echo ""

# ============================================================
# Step 4: Run DOWN
# ============================================================
echo -e "${CYAN}[STEP 4/6] Running migrations DOWN...${NC}"
run_migrate down
echo -e "${GREEN}[OK] DOWN completed successfully!${NC}"
echo ""

# ============================================================
# Step 5: Run UP again
# ============================================================
echo -e "${CYAN}[STEP 5/6] Running migrations UP again...${NC}"
run_migrate up
echo -e "${GREEN}[OK] UP (second time) completed successfully!${NC}"
echo ""

# ============================================================
# Step 6: Check Migration Status (After)
# ============================================================
echo -e "${CYAN}[STEP 6/6] Checking migration status (after)...${NC}"
run_migrate status
echo ""

# ============================================================
# Clean up (optional)
# ============================================================
if [ "$CLEAN_UP" = true ]; then
    echo -e "${YELLOW}[CLEANUP] Stopping and removing containers...${NC}"
    docker compose -f "$COMPOSE_FILE" down -v
    echo -e "${GREEN}[OK] Cleanup completed!${NC}"
fi

# ============================================================
# Summary
# ============================================================
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Test Complete! UP -> DOWN -> UP All Passed!           ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "Commands for manual testing:"
echo ""
echo "  # Check status"
echo "  docker compose -f $COMPOSE_FILE --profile tools run --rm migrate status -c $CONFIG"
echo ""
echo "  # Run up"
echo "  docker compose -f $COMPOSE_FILE --profile tools run --rm migrate up -c $CONFIG"
echo ""
echo "  # Run down"
echo "  docker compose -f $COMPOSE_FILE --profile tools run --rm migrate down -c $CONFIG"
echo ""
echo "  # Stop database"
echo "  docker compose -f $COMPOSE_FILE down"
echo ""
echo "  # Stop and remove volumes"
echo "  docker compose -f $COMPOSE_FILE down -v"
echo ""
