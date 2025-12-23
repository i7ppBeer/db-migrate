#!/bin/bash

#############################################
# Kubernetes Migration Runner Script
# 1. Tests migrations on embedded MongoDB (6.0, 7.0, 8.0)
# 2. If tests pass, applies to production MongoDB
# 3. Auto-rollback on failure
#############################################

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
TEST_VERSIONS="${TEST_VERSIONS:-6.0 7.0 8.0}"
MONGODB_TEST_PORT=27017
MONGODB_PROD_URL="${MONGODB_URL}"
MONGODB_PROD_DB="${MONGODB_DATABASE}"
DRY_RUN="${DRY_RUN:-false}"
SKIP_TESTS="${SKIP_TESTS:-false}"

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_header() {
    echo -e "\n${CYAN}========================================${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}========================================${NC}\n"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if [ -z "$MONGODB_PROD_URL" ]; then
        log_error "MONGODB_URL environment variable is not set"
        exit 1
    fi
    
    if [ -z "$MONGODB_PROD_DB" ]; then
        log_error "MONGODB_DATABASE environment variable is not set"
        exit 1
    fi
    
    log_success "Prerequisites check passed"
}

# Start MongoDB test instance
start_test_mongodb() {
    local version=$1
    local port=$2
    
    log_info "Starting MongoDB $version on port $port using Docker..."
    
    # Container name
    local container_name="mongodb-test-$version"
    
    # Stop and remove any existing container
    docker stop $container_name 2>/dev/null || true
    docker rm $container_name 2>/dev/null || true
    sleep 2
    
    # Start MongoDB container
    docker run -d \
        --name $container_name \
        -p $port:27017 \
        mongo:$version \
        --bind_ip_all \
        --noauth
    
    # Wait for MongoDB to be ready
    local max_attempts=30
    local attempt=0
    
    sleep 3  # 給 MongoDB 一點啟動時間
    
    while [ $attempt -lt $max_attempts ]; do
        if docker exec $container_name mongosh --quiet --eval "db.adminCommand('ping').ok" 2>/dev/null | grep -q "1"; then
            log_success "MongoDB $version is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    
    log_error "MongoDB $version failed to start"
    docker logs $container_name
    return 1
}

# Stop MongoDB test instance
stop_test_mongodb() {
    local version=$1
    local container_name="mongodb-test-$version"
    
    log_info "Stopping MongoDB $version..."
    docker stop $container_name 2>/dev/null || true
    docker rm $container_name 2>/dev/null || true
    sleep 2
    log_success "MongoDB stopped"
}

# Test migrations on specific version
test_migrations() {
    local version=$1
    local port=$2
    
    log_header "Testing Migrations on MongoDB $version"
    
    # Start test MongoDB
    start_test_mongodb $version $port || return 1
    
    # Configure test database (remove dots from version for database name)
    local db_version=$(echo "$version" | tr -d '.')
    export MONGODB_URL="mongodb://127.0.0.1:$port"
    export MONGODB_DATABASE="migration_test_v${db_version}"
    
    # Validate migrations
    log_info "Validating migration files..."
    if ! node src/cli.js validate; then
        log_error "Migration validation failed on MongoDB $version"
        stop_test_mongodb $version
        return 1
    fi
    log_success "Validation passed"
    
    # Run migrations UP
    log_info "Running migrations UP..."
    if ! node src/cli.js up; then
        log_error "Migration UP failed on MongoDB $version"
        stop_test_mongodb $version
        return 1
    fi
    log_success "Migrations UP successful"
    
    # Check migration status
    log_info "Checking migration status..."
    node src/cli.js status
    
    # Test rollback (down the last migration)
    log_info "Testing rollback..."
    if ! node src/cli.js down; then
        log_warning "Rollback test failed (non-critical)"
    else
        log_success "Rollback test passed"
        
        # Re-apply the migration
        log_info "Re-applying migration..."
        node src/cli.js up
    fi
    
    # Stop test MongoDB
    stop_test_mongodb $version
    
    log_success "MongoDB $version test completed successfully"
    return 0
}

# Get current migration state (for rollback)
get_migration_state() {
    log_info "Capturing current migration state..."
    
    export MONGODB_URL="$MONGODB_PROD_URL"
    export MONGODB_DATABASE="$MONGODB_PROD_DB"
    
    node src/cli.js status > /tmp/migration_state_before.txt 2>&1 || true
    
    # Count applied migrations
    MIGRATIONS_BEFORE=$(grep -c "│.*│.*Z.*│" /tmp/migration_state_before.txt 2>/dev/null || echo "0")
    
    log_info "Current applied migrations: $MIGRATIONS_BEFORE"
}

# Rollback to previous state
rollback_migrations() {
    log_warning "Rolling back migrations to previous state..."
    
    export MONGODB_URL="$MONGODB_PROD_URL"
    export MONGODB_DATABASE="$MONGODB_PROD_DB"
    
    # Get current state
    node src/cli.js status > /tmp/migration_state_after.txt 2>&1 || true
    MIGRATIONS_AFTER=$(grep -c "│.*│.*Z.*│" /tmp/migration_state_after.txt 2>/dev/null || echo "0")
    
    # Calculate how many migrations to rollback
    ROLLBACK_COUNT=$((MIGRATIONS_AFTER - MIGRATIONS_BEFORE))
    
    if [ $ROLLBACK_COUNT -le 0 ]; then
        log_info "No migrations to rollback"
        return 0
    fi
    
    log_warning "Rolling back $ROLLBACK_COUNT migration(s)..."
    
    for ((i=1; i<=ROLLBACK_COUNT; i++)); do
        log_info "Rollback $i/$ROLLBACK_COUNT..."
        if ! node src/cli.js down; then
            log_error "Rollback failed at step $i"
            return 1
        fi
    done
    
    log_success "Rollback completed successfully"
    return 0
}

# Apply migrations to production
apply_to_production() {
    log_header "Applying Migrations to Production"
    
    # Get current state for potential rollback
    get_migration_state
    
    # Configure production database
    export MONGODB_URL="$MONGODB_PROD_URL"
    export MONGODB_DATABASE="$MONGODB_PROD_DB"
    
    log_info "Target: $MONGODB_PROD_URL"
    log_info "Database: $MONGODB_PROD_DB"
    
    if [ "$DRY_RUN" = "true" ]; then
        log_warning "DRY RUN MODE - No changes will be made"
        node src/cli.js up --dry-run
        return 0
    fi
    
    # Show pending migrations
    log_info "Checking pending migrations..."
    node src/cli.js status
    
    # Apply migrations
    log_info "Applying migrations to production..."
    if ! node src/cli.js up; then
        log_error "Production migration failed!"
        
        # Attempt rollback
        if rollback_migrations; then
            log_success "Rollback completed successfully"
        else
            log_error "Rollback also failed! Manual intervention required!"
        fi
        
        return 1
    fi
    
    log_success "Production migrations applied successfully"
    
    # Verify final state
    log_info "Final migration status:"
    node src/cli.js status
    
    return 0
}

# Main execution flow
main() {
    log_header "MongoDB Migration Runner - Kubernetes Edition"
    
    # Check prerequisites
    check_prerequisites
    
    # Run tests if not skipped
    if [ "$SKIP_TESTS" = "false" ]; then
        log_header "Phase 1: Testing on Embedded MongoDB"
        
        local test_failed=false
        
        for version in $TEST_VERSIONS; do
            if ! test_migrations "$version" "$MONGODB_TEST_PORT"; then
                log_error "Tests failed on MongoDB $version"
                test_failed=true
                break
            fi
        done
        
        if [ "$test_failed" = "true" ]; then
            log_error "Migration tests failed. Aborting production deployment."
            exit 1
        fi
        
        log_success "All version tests passed!"
    else
        log_warning "Tests skipped (SKIP_TESTS=true)"
    fi
    
    # Apply to production
    log_header "Phase 2: Production Deployment"
    
    if ! apply_to_production; then
        log_error "Production deployment failed"
        exit 1
    fi
    
    log_header "Migration Completed Successfully"
    log_success "All migrations applied and verified!"
    
    exit 0
}

# Trap errors
trap 'log_error "Script failed at line $LINENO"' ERR

# Run main function
main "$@"
