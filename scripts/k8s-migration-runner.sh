#!/bin/bash

#############################################
# Kubernetes Migration Runner Script
# 1. Tests migrations on embedded MongoDB (6.0, 7.0, 8.0) (Optional)
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
SKIP_TESTS="${SKIP_TESTS:-true}" # Default to true for K8s Job

# Logging functions
log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }
log_header() { echo -e "\n${CYAN}========================================${NC}\n${CYAN}$1${NC}\n${CYAN}========================================${NC}\n"; }

# Identify Projects
PROJECTS=()
if [ -n "$PROJECT_NAME" ]; then
    if [ -d "projects/$PROJECT_NAME" ]; then
        PROJECTS+=("projects/$PROJECT_NAME")
    else
        log_error "Project not found: projects/$PROJECT_NAME"
        exit 1
    fi
else
    for d in projects/*; do
        if [ -d "$d" ]; then
            PROJECTS+=("$d")
        fi
    done
fi

if [ ${#PROJECTS[@]} -eq 0 ]; then
    log_error "No projects found!"
    exit 1
fi

log_info "Found ${#PROJECTS[@]} project(s) to process:"
for p in "${PROJECTS[@]}"; do
    echo "  - $(basename "$p")"
done

# Check prerequisites
check_prerequisites() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    if ! command -v docker &> /dev/null && [ "$SKIP_TESTS" = "false" ]; then
        log_warning "Docker is not installed. Skipping tests."
        SKIP_TESTS="true"
    fi
}

# Run tests on embedded MongoDB
test_project_on_version() {
    local project_dir=$1
    local version=$2
    local port=$3
    local config_file="$project_dir/config.js"
    
    log_info "Testing $(basename "$project_dir") on MongoDB $version..."
    
    local container_name="mongo-test-$version"
    # Start container if not running
    if ! docker ps | grep -q "$container_name"; then
        docker run -d --name "$container_name" -p "$port:27017" "mongo:$version" > /dev/null
        sleep 5
    fi
    
    export MONGODB_URL="mongodb://localhost:$port"
    export MONGODB_DATABASE="test_db_$(basename "$project_dir")"
    
    if ! node src/cli.js up -c "$config_file"; then
        log_error "Migration UP failed for $(basename "$project_dir") on MongoDB $version"
        return 1
    fi
    
    if ! node src/cli.js down -c "$config_file"; then
        log_error "Migration DOWN failed for $(basename "$project_dir") on MongoDB $version"
        return 1
    fi
    
    return 0
}

# Apply to production
apply_project_production() {
    local project_dir=$1
    local config_file="$project_dir/config.js"
    
    log_info "Applying $(basename "$project_dir") to production..."
    
    if [ "$DRY_RUN" = "true" ]; then
        log_info "DRY RUN: Skipping actual migration"
        return 0
    fi
    
    # Note: MONGODB_URL and MONGODB_DATABASE are set in env (from K8s secrets)
    # If MONGODB_DATABASE is set, it overrides config.js.
    # If you want separate DBs per project, ensure MONGODB_DATABASE is NOT set in K8s env,
    # or set it dynamically here based on project name.
    
    if ! node src/cli.js up -c "$config_file"; then
        log_error "Production migration failed for $(basename "$project_dir")!"
        
        log_warning "Attempting rollback..."
        if node src/cli.js down -c "$config_file"; then
            log_success "Rollback successful"
        else
            log_error "Rollback failed! Manual intervention required!"
        fi
        return 1
    fi
    
    log_success "Successfully migrated $(basename "$project_dir")"
    return 0
}

cleanup_containers() {
    if [ "$SKIP_TESTS" = "false" ]; then
        log_info "Cleaning up test containers..."
        for version in $TEST_VERSIONS; do
            docker rm -f "mongo-test-$version" > /dev/null 2>&1 || true
        done
    fi
}

main() {
    log_header "MongoDB Migration Runner - Kubernetes Edition"
    check_prerequisites
    
    # Phase 1: Testing
    if [ "$SKIP_TESTS" = "false" ]; then
        log_header "Phase 1: Testing on Embedded MongoDB"
        trap cleanup_containers EXIT
        
        for version in $TEST_VERSIONS; do
            for project in "${PROJECTS[@]}"; do
                if ! test_project_on_version "$project" "$version" "$MONGODB_TEST_PORT"; then
                    log_error "Tests failed. Aborting."
                    exit 1
                fi
            done
        done
        log_success "All tests passed!"
    else
        log_info "Skipping tests (SKIP_TESTS=true)"
    fi
    
    # Phase 2: Production
    log_header "Phase 2: Production Deployment"
    
    if [ -z "$MONGODB_PROD_URL" ] && [ "$DRY_RUN" != "true" ]; then
        log_error "MONGODB_URL is not set"
        exit 1
    fi
    
    for project in "${PROJECTS[@]}"; do
        if ! apply_project_production "$project"; then
            exit 1
        fi
    done
    
    log_success "All projects migrated successfully!"
}

main
