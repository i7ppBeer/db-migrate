#!/bin/bash

# Test All Migrations Script
# This script tests all migration files by running up and down operations

set -e

# Get script directory and project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "🚀 Testing All Migrations in Docker Container"
echo "=============================================="
echo "Project Root: $PROJECT_ROOT"
echo ""

# Change to project root
cd "$PROJECT_ROOT"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
CONTAINER_NAME="mongodb-migrate-test"
MONGO_PORT=27017
MONGO_VERSION="7.0"

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}🧹 Cleaning up...${NC}"
    docker stop $CONTAINER_NAME 2>/dev/null || true
    docker rm $CONTAINER_NAME 2>/dev/null || true
}

# Set trap for cleanup
trap cleanup EXIT

# Start MongoDB container
echo -e "${BLUE}📦 Starting MongoDB ${MONGO_VERSION} container...${NC}"
docker run -d \
    --name $CONTAINER_NAME \
    -p $MONGO_PORT:27017 \
    mongo:$MONGO_VERSION

# Wait for MongoDB to be ready
echo -e "${BLUE}⏳ Waiting for MongoDB to be ready...${NC}"
sleep 5

# Check if MongoDB is ready
for i in {1..30}; do
    if docker exec $CONTAINER_NAME mongosh --eval "db.adminCommand('ping')" &>/dev/null; then
        echo -e "${GREEN}✅ MongoDB is ready!${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ MongoDB failed to start${NC}"
        exit 1
    fi
    sleep 1
done

# Update database in migrate-mongo config temporarily
echo -e "\n${BLUE}📝 Using test database...${NC}"
export MONGODB_DATABASE="test_migrations"

# Check migration status before
echo -e "\n${BLUE}📊 Migration Status (Before):${NC}"
node src/cli.js status || true

# Run all migrations UP
echo -e "\n${GREEN}⬆️  Running all migrations UP...${NC}"
node src/cli.js up

# Show status after up
echo -e "\n${BLUE}📊 Migration Status (After UP):${NC}"
node src/cli.js status

# Verify collections were created
echo -e "\n${BLUE}🔍 Verifying collections...${NC}"
docker exec $CONTAINER_NAME mongosh test_migrations --eval "
  const collections = db.getCollectionNames();
  print('Collections created: ' + collections.length);
  collections.forEach(c => print('  - ' + c));
"

# Check some indexes
echo -e "\n${BLUE}🔍 Checking indexes on 'users' collection...${NC}"
docker exec $CONTAINER_NAME mongosh test_migrations --eval "
  const indexes = db.users.getIndexes();
  print('Indexes on users collection: ' + indexes.length);
  indexes.forEach(idx => print('  - ' + idx.name));
"

# Run all migrations DOWN
echo -e "\n${YELLOW}⬇️  Running all migrations DOWN...${NC}"
node src/cli.js down

# Show status after down
echo -e "\n${BLUE}📊 Migration Status (After DOWN):${NC}"
node src/cli.js status

# Verify indexes were removed
echo -e "\n${BLUE}🔍 Verifying indexes removed...${NC}"
docker exec $CONTAINER_NAME mongosh test_migrations --eval "
  const collections = db.getCollectionNames();
  print('Collections remaining: ' + collections.length);
  collections.forEach(c => {
    const indexes = db[c].getIndexes();
    print('  - ' + c + ': ' + indexes.length + ' indexes');
  });
"

# Run migrations UP again to test idempotency
echo -e "\n${GREEN}⬆️  Running migrations UP again (testing idempotency)...${NC}"
node src/cli.js up

# Final status
echo -e "\n${BLUE}📊 Final Migration Status:${NC}"
node src/cli.js status

echo -e "\n${GREEN}✅ All migration tests completed successfully!${NC}"
echo -e "\n${BLUE}Summary:${NC}"
echo "  - Container: $CONTAINER_NAME (MongoDB $MONGO_VERSION)"
echo "  - Migrations tested: $(ls -1 migrations/202*.js | wc -l)"
echo "  - All operations: UP → DOWN → UP ✅"
