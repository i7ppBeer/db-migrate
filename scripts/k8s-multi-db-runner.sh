#!/bin/bash

#############################################
# Kubernetes Multi-Database Migration Runner
# Tests migrations on embedded MongoDB for multiple databases
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
DRY_RUN="${DRY_RUN:-false}"

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

# Get all config files
get_config_files() {
    local configs=()
    for config in config/example-app-*.js; do
        if [ -f "$config" ]; then
            configs+=("$config")
        fi
    done
    echo "${configs[@]}"
}

# Extract database name from config filename
get_db_name() {
    local config="$1"
    basename "$config" | sed 's/example-app-//' | sed 's/.js$//'
}

# Test single database on specific MongoDB version
test_database_on_version() {
    local config="$1"
    local version="$2"
    local db_name=$(get_db_name "$config")
    
    log_info "Testing $db_name on MongoDB $version..."
    
    # Start MongoDB container
    local container_name="mongo-test-${db_name}-${version//./}"
    docker run -d --name "$container_name" \
        -p "$MONGODB_TEST_PORT:27017" \
        "mongo:$version" >/dev/null 2>&1
    
    # Wait for MongoDB to be ready
    sleep 5
    
    # Set environment variables for this database
    local db_url_var=$(echo "${db_name}_DB_URL" | tr '[:lower:]' '[:upper:]')
    local db_name_var=$(echo "${db_name}_DB_NAME" | tr '[:lower:]' '[:upper:]')
    
    export ${db_url_var}="mongodb://localhost:$MONGODB_TEST_PORT"
    export ${db_name_var}="${db_name}_db"
    
    # Run migration up
    if node src/cli.js --config "$config" up >/dev/null 2>&1; then
        log_success "$db_name migration UP succeeded on MongoDB $version"
        
        # Verify migration status
        local applied=$(node src/cli.js --config "$config" status 2>/dev/null | grep -c "2025" || true)
        log_info "$db_name: $applied migrations applied"
        
        # Clean up container
        docker stop "$container_name" >/dev/null 2>&1
        docker rm "$container_name" >/dev/null 2>&1
        
        return 0
    else
        log_error "$db_name migration FAILED on MongoDB $version"
        docker stop "$container_name" >/dev/null 2>&1
        docker rm "$container_name" >/dev/null 2>&1
        return 1
    fi
}

# Main execution
main() {
    log_header "Kubernetes Multi-Database Migration Test"
    
    # Get all config files
    local configs=($(get_config_files))
    
    if [ ${#configs[@]} -eq 0 ]; then
        log_error "No database configs found in config/"
        exit 1
    fi
    
    log_info "Found ${#configs[@]} databases to test"
    for config in "${configs[@]}"; do
        echo "  - $(get_db_name "$config")"
    done
    
    local total_tests=0
    local passed_tests=0
    local failed_tests=0
    
    # Test each database on each MongoDB version
    for version in $TEST_VERSIONS; do
        log_header "Testing MongoDB $version"
        
        for config in "${configs[@]}"; do
            ((total_tests++))
            
            if test_database_on_version "$config" "$version"; then
                ((passed_tests++))
            else
                ((failed_tests++))
            fi
        done
    done
    
    # Summary
    log_header "Test Summary"
    echo -e "${BLUE}Total tests:${NC} $total_tests"
    echo -e "${GREEN}Passed:${NC} $passed_tests"
    echo -e "${RED}Failed:${NC} $failed_tests"
    
    if [ $failed_tests -eq 0 ]; then
        log_success "All migrations passed on all MongoDB versions!"
        exit 0
    else
        log_error "Some migrations failed"
        exit 1
    fi
}

# Run main function
main "$@"
