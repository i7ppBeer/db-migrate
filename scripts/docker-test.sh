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
VERSIONS=("8.0")
CONTAINER_NAME="mongodb-migrate-test"
NETWORK_NAME="mongodb-test-network"
PORT=27017

# Functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}[OK] $1${NC}"
}

print_error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

print_info() {
    echo -e "${YELLOW}[INFO]  $1${NC}"
}

print_step() {
    echo -e "${CYAN}[STEP]  $1${NC}"
}

# Cleanup function
cleanup() {
    print_info "Cleaning up..."
    docker stop ${CONTAINER_NAME} 2>/dev/null || true
    docker rm ${CONTAINER_NAME} 2>/dev/null || true
    docker network rm ${NETWORK_NAME} 2>/dev/null || true
}

# Trap errors and cleanup
trap cleanup EXIT

# Create docker network
print_step "Creating Docker network..."
docker network create ${NETWORK_NAME} 2>/dev/null || true

# Main Loop
for VERSION in "${VERSIONS[@]}"; do
    print_header "Testing MongoDB $VERSION"
    
    # Pull Image once per version
    print_step "Pulling MongoDB $VERSION image..."
    docker pull mongo:$VERSION > /dev/null 2>&1
    
    for PROJECT_PATH in databases/*; do
        if [ ! -d "$PROJECT_PATH" ]; then continue; fi
        
        PROJECT_NAME=$(basename "$PROJECT_PATH")
        
        # Skip test databases with intentional failures
        if [[ "$PROJECT_NAME" == "dangerous_legacy" || "$PROJECT_NAME" == "users" ]]; then
            print_info "Skipping $PROJECT_NAME (contains test migrations)"
            continue
        fi
        
        print_header "Testing Project: $PROJECT_NAME on MongoDB $VERSION"
        
        # Start Container for this specific test case
        print_step "Starting MongoDB $VERSION container..."
        
        # Ensure clean state
        docker stop ${CONTAINER_NAME} 2>/dev/null || true
        docker rm ${CONTAINER_NAME} 2>/dev/null || true
        
        docker run -d --name ${CONTAINER_NAME} \
            --network ${NETWORK_NAME} \
            -p ${PORT}:27017 \
            -e MONGO_INITDB_ROOT_USERNAME=admin \
            -e MONGO_INITDB_ROOT_PASSWORD=admin123 \
            mongo:$VERSION > /dev/null 2>&1
            
        # Wait for Ready
        print_step "Waiting for MongoDB to be ready..."
        sleep 5
        max_attempts=30
        attempt=0
        while [ $attempt -lt $max_attempts ]; do
            if docker exec ${CONTAINER_NAME} mongosh --eval "db.adminCommand({ping: 1})" --quiet 2>/dev/null; then
                print_success "MongoDB is ready!"
                break
            fi
            attempt=$((attempt + 1))
            sleep 1
        done
        
        if [ $attempt -eq $max_attempts ]; then
            print_error "MongoDB failed to start"
            exit 1
        fi
        
        # Configure Env
        CONN_STR="mongodb://admin:admin123@localhost:${PORT}" 
        CONFIG_FILE="$PROJECT_PATH/config.js"
        export MONGODB_URL="$CONN_STR"

        # 1. Initial Status
        print_step "Checking Initial Status..."
        node src/cli.js status -c "$CONFIG_FILE"
        
       
        # 2. Up
        print_step "Running Migrations (UP)..."
        # If UP fails, we attempt to rollback to clean state before exiting
        if ! node src/cli.js up -c "$CONFIG_FILE"; then
            print_error "UP failed - Attempting automatic rollback..."
            node src/cli.js down -c "$CONFIG_FILE"
            exit 1
        fi
        
        # 3. Status after Up
        print_step "Checking Status after UP..."
        node src/cli.js status -c "$CONFIG_FILE"
        
        # 4. Down (Rollback ALL)
        print_step "Testing Full Rollback (DOWN ALL)..."
        
        # Loop until no applied migrations remain
        while true; do
            STATUS=$(node src/cli.js status -c "$CONFIG_FILE")
            if echo "$STATUS" | grep -q "APPLIED"; then
                node src/cli.js down -c "$CONFIG_FILE" || { print_error "DOWN failed"; exit 1; }
            else
                print_success "All migrations rolled back."
                break
            fi
        done
        
        # 5. Status after Down
        print_step "Checking Status after Full Rollback..."
        node src/cli.js status -c "$CONFIG_FILE"
        
        # 6. Up again
        print_step "Re-applying Migrations (UP)..."
        node src/cli.js up -c "$CONFIG_FILE" || { print_error "Re-UP failed"; exit 1; }
        
        # 7. Final Status
        print_step "Checking Final Status..."
        node src/cli.js status -c "$CONFIG_FILE"
        
        print_success "Project $PROJECT_NAME passed on MongoDB $VERSION"
        
        # Stop container
        docker stop ${CONTAINER_NAME} > /dev/null 2>&1
        docker rm ${CONTAINER_NAME} > /dev/null 2>&1
    done
done

print_header "[OK] All Tests Passed Successfully!"
