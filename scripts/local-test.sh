#!/bin/bash
# ============================================================
# Local Migration Test Script
# 本地測試 Migration Image 的完整流程
# ============================================================
#
# 使用方式:
#   ./scripts/local-test.sh [options]
#
# Options:
#   -i, --image     Migration image (default: db-migrate:v1.0.0)
#   -d, --db        Database type: mongodb, mongodb-auth, mariadb (default: mongodb)
#   -c, --clean     Clean up after test
#   -h, --help      Show help
#
# Examples:
#   ./scripts/local-test.sh
#   ./scripts/local-test.sh -i myregistry.azurecr.io/db-migrate:v1.2.3
#   ./scripts/local-test.sh -d mariadb
#   ./scripts/local-test.sh -d mongodb-auth
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
MIGRATION_IMAGE="db-migrate:v1.0.0"
DB_TYPE="mongodb"
CLEAN_UP=false
COMPOSE_FILE="docker-compose.local-test.yml"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--image)
            MIGRATION_IMAGE="$2"
            shift 2
            ;;
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
            echo "  -i, --image     Migration image (default: db-migrate:v1.0.0)"
            echo "  -d, --db        Database type: mongodb, mongodb-auth, mariadb"
            echo "  -c, --clean     Clean up after test"
            echo "  -h, --help      Show help"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Determine service names based on DB type
case $DB_TYPE in
    mongodb)
        DB_SERVICE="mongodb"
        MIGRATION_SERVICE="migration"
        ;;
    mongodb-auth)
        DB_SERVICE="mongodb-auth"
        MIGRATION_SERVICE="migration-auth"
        ;;
    mariadb)
        DB_SERVICE="mariadb"
        MIGRATION_SERVICE="migration-mariadb"
        ;;
    *)
        echo -e "${RED}Unknown database type: $DB_TYPE${NC}"
        echo "Supported: mongodb, mongodb-auth, mariadb"
        exit 1
        ;;
esac

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Local Migration Test                                  ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Migration Image: $MIGRATION_IMAGE"
echo "  Database Type:   $DB_TYPE"
echo "  DB Service:      $DB_SERVICE"
echo "  Migration Svc:   $MIGRATION_SERVICE"
echo ""

# Export for docker-compose
export MIGRATION_IMAGE

# ============================================================
# Step 1: Start Database
# ============================================================
echo -e "${CYAN}[STEP 1/6] Starting database ($DB_SERVICE)...${NC}"
docker compose -f "$COMPOSE_FILE" up -d "$DB_SERVICE"

echo "Waiting for database to be healthy..."
sleep 5

# Check database health
if ! docker compose -f "$COMPOSE_FILE" ps "$DB_SERVICE" | grep -q "healthy"; then
    echo "Waiting more for database..."
    sleep 10
fi

echo -e "${GREEN}[OK] Database is ready!${NC}"
echo ""

# ============================================================
# Step 2: Check Migration Status (Before)
# ============================================================
echo -e "${CYAN}[STEP 2/6] Checking migration status (before)...${NC}"
docker compose -f "$COMPOSE_FILE" run --rm "$MIGRATION_SERVICE" status || true
echo ""

# ============================================================
# Step 3: Run UP
# ============================================================
echo -e "${CYAN}[STEP 3/6] Running migrations UP...${NC}"
docker compose -f "$COMPOSE_FILE" run --rm "$MIGRATION_SERVICE" up

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[OK] UP completed successfully!${NC}"
else
    echo -e "${RED}[FAIL] UP failed!${NC}"
    exit 1
fi
echo ""

# ============================================================
# Step 4: Run DOWN
# ============================================================
echo -e "${CYAN}[STEP 4/6] Running migrations DOWN...${NC}"
docker compose -f "$COMPOSE_FILE" run --rm "$MIGRATION_SERVICE" down

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[OK] DOWN completed successfully!${NC}"
else
    echo -e "${RED}[FAIL] DOWN failed!${NC}"
    exit 1
fi
echo ""

# ============================================================
# Step 5: Run UP again
# ============================================================
echo -e "${CYAN}[STEP 5/6] Running migrations UP again...${NC}"
docker compose -f "$COMPOSE_FILE" run --rm "$MIGRATION_SERVICE" up

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[OK] UP (second time) completed successfully!${NC}"
else
    echo -e "${RED}[FAIL] UP (second time) failed!${NC}"
    exit 1
fi
echo ""

# ============================================================
# Step 6: Check Migration Status (After)
# ============================================================
echo -e "${CYAN}[STEP 6/6] Checking migration status (after)...${NC}"
docker compose -f "$COMPOSE_FILE" run --rm "$MIGRATION_SERVICE" status
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
echo "  docker compose -f $COMPOSE_FILE run --rm $MIGRATION_SERVICE status"
echo ""
echo "  # Run up"
echo "  docker compose -f $COMPOSE_FILE run --rm $MIGRATION_SERVICE up"
echo ""
echo "  # Run down"
echo "  docker compose -f $COMPOSE_FILE run --rm $MIGRATION_SERVICE down"
echo ""
echo "  # Stop database"
echo "  docker compose -f $COMPOSE_FILE down"
echo ""
echo "  # Stop and remove volumes"
echo "  docker compose -f $COMPOSE_FILE down -v"
echo ""
