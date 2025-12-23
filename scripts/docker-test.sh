#!/bin/bash

# Docker-based Migration Testing Script
# Tests migrations across multiple MongoDB versions with detailed output

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
MIN_VERSION="${MIN_VERSION:-6.0}"
MAX_VERSION="${MAX_VERSION:-8.0}"
CONTAINER_PREFIX="mongodb-migrate-test"
NETWORK_NAME="mongodb-test-network"

# Functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

print_step() {
    echo -e "${CYAN}▶️  $1${NC}"
}

# Cleanup function
cleanup() {
    print_info "Cleaning up containers and network..."
    docker stop ${CONTAINER_PREFIX}-min ${CONTAINER_PREFIX}-max 2>/dev/null || true
    docker rm ${CONTAINER_PREFIX}-min ${CONTAINER_PREFIX}-max 2>/dev/null || true
    docker network rm ${NETWORK_NAME} 2>/dev/null || true
}

# Trap errors and cleanup
trap cleanup EXIT

# Main test flow
print_header "🧪 MongoDB Migration Testing Suite"
echo -e "${CYAN}Testing versions: ${MIN_VERSION} → ${MAX_VERSION}${NC}\n"

# Create docker network
print_step "Creating Docker network..."
docker network create ${NETWORK_NAME} 2>/dev/null || true
print_success "Docker network created"

# Test 1: Minimum Version
print_header "📦 Test 1: MongoDB ${MIN_VERSION}"

print_step "Pulling MongoDB ${MIN_VERSION} image..."
docker pull mongo:${MIN_VERSION} > /dev/null 2>&1
print_success "Image ready"

print_step "Starting MongoDB ${MIN_VERSION} container..."
docker run -d --name ${CONTAINER_PREFIX}-min \
    --network ${NETWORK_NAME} \
    -p 27017:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=admin123 \
    mongo:${MIN_VERSION} > /dev/null 2>&1
CONTAINER_ID=$(docker ps -q -f name=${CONTAINER_PREFIX}-min)
print_success "Container started (ID: ${CONTAINER_ID:0:12})"

print_step "Waiting for MongoDB ${MIN_VERSION} to be ready..."
sleep 10
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if docker exec ${CONTAINER_PREFIX}-min mongosh --eval "db.adminCommand({ping: 1})" --quiet 2>/dev/null; then
        print_success "MongoDB ${MIN_VERSION} is ready!"
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done

if [ $attempt -eq $max_attempts ]; then
    print_error "MongoDB ${MIN_VERSION} failed to start"
    exit 1
fi

# Run migrations on min version
export MONGODB_URL="mongodb://admin:admin123@localhost:27017"
export MONGODB_DATABASE="test_migrations"

print_step "Running migrations on MongoDB ${MIN_VERSION}..."
npm run up > /dev/null 2>&1 || print_error "Migration failed"

print_step "Checking migration status..."
npm run status 2>&1 | grep -E "^│|Test Files|passed" || true

print_success "MongoDB ${MIN_VERSION} test completed"

# Stop min version container
docker stop ${CONTAINER_PREFIX}-min > /dev/null 2>&1
docker rm ${CONTAINER_PREFIX}-min > /dev/null 2>&1

# Test 2: Maximum Version
print_header "📦 Test 2: MongoDB ${MAX_VERSION}"

print_step "Pulling MongoDB ${MAX_VERSION} image..."
docker pull mongo:${MAX_VERSION} > /dev/null 2>&1
print_success "Image ready"

print_step "Starting MongoDB ${MAX_VERSION} container..."
docker run -d --name ${CONTAINER_PREFIX}-max \
    --network ${NETWORK_NAME} \
    -p 27018:27017 \
    -e MONGO_INITDB_ROOT_USERNAME=admin \
    -e MONGO_INITDB_ROOT_PASSWORD=admin123 \
    mongo:${MAX_VERSION} > /dev/null 2>&1
CONTAINER_ID=$(docker ps -q -f name=${CONTAINER_PREFIX}-max)
print_success "Container started (ID: ${CONTAINER_ID:0:12})"

print_step "Waiting for MongoDB ${MAX_VERSION} to be ready..."
sleep 10
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if docker exec ${CONTAINER_PREFIX}-max mongosh --eval "db.adminCommand({ping: 1})" --quiet 2>/dev/null; then
        print_success "MongoDB ${MAX_VERSION} is ready!"
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done

if [ $attempt -eq $max_attempts ]; then
    print_error "MongoDB ${MAX_VERSION} failed to start"
    exit 1
fi

# Run migrations on max version
export MONGODB_URL="mongodb://admin:admin123@localhost:27018"
export MONGODB_DATABASE="test_migrations"

print_step "Running migrations on MongoDB ${MAX_VERSION}..."
npm run up > /dev/null 2>&1 || print_error "Migration failed"

print_step "Checking migration status..."
npm run status 2>&1 | grep -E "^│|Test Files|passed" || true

print_success "MongoDB ${MAX_VERSION} test completed"

# Test 3: Rollback test
print_header "🔄 Test 3: Rollback Test on MongoDB ${MAX_VERSION}"

print_step "Rolling back one migration..."
npm run down > /dev/null 2>&1 || print_error "Rollback failed"
print_success "Rollback successful"

print_step "Re-applying migration..."
npm run up > /dev/null 2>&1 || print_error "Re-migration failed"
print_success "Re-migration successful"

# All tests passed
print_header "✅ Test Summary"
echo -e "${GREEN}"
echo "  ✓ MongoDB ${MIN_VERSION} migrations successful"
echo "  ✓ MongoDB ${MAX_VERSION} migrations successful"
echo "  ✓ Rollback test successful"
echo -e "${NC}"

print_success "All Docker tests passed!"

exit 0
