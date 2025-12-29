#!/bin/bash

# Kubernetes Deployment Script
# Deploys migrations to Kubernetes with validation and rollback support

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
NAMESPACE="${NAMESPACE:-mongodb-migrations}"
MIGRATION_JOB_NAME="mongodb-migration"
ROLLBACK_JOB_NAME="mongodb-rollback"
TIMEOUT="${TIMEOUT:-600}"

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
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    print_error "kubectl is not installed"
    exit 1
fi

# Function to wait for job completion
wait_for_job() {
    local job_name=$1
    local namespace=$2
    local timeout=$3
    
    print_info "Waiting for job ${job_name} to complete (timeout: ${timeout}s)..."
    
    if kubectl wait --for=condition=complete \
        --timeout=${timeout}s \
        job/${job_name} \
        -n ${namespace} 2>/dev/null; then
        return 0
    else
        # Check if job failed
        if kubectl wait --for=condition=failed \
            --timeout=5s \
            job/${job_name} \
            -n ${namespace} 2>/dev/null; then
            return 1
        else
            return 2
        fi
    fi
}

# Function to get job logs
get_job_logs() {
    local job_name=$1
    local namespace=$2
    
    local pod_name=$(kubectl get pods \
        -n ${namespace} \
        -l job-name=${job_name} \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [ -n "$pod_name" ]; then
        kubectl logs ${pod_name} -n ${namespace} --all-containers=true
    fi
}

# Function to rollback migration
rollback_migration() {
    print_header "Starting Rollback Process"
    
    # Delete existing rollback job if exists
    kubectl delete job ${ROLLBACK_JOB_NAME} -n ${NAMESPACE} 2>/dev/null || true
    
    # Create rollback job
    print_info "Creating rollback job..."
    kubectl apply -f k8s/rollback-job.yaml
    
    # Wait for rollback to complete
    if wait_for_job ${ROLLBACK_JOB_NAME} ${NAMESPACE} ${TIMEOUT}; then
        print_success "Rollback completed successfully"
        get_job_logs ${ROLLBACK_JOB_NAME} ${NAMESPACE}
        return 0
    else
        print_error "Rollback failed"
        get_job_logs ${ROLLBACK_JOB_NAME} ${NAMESPACE}
        return 1
    fi
}

# Main deployment flow
print_header "Kubernetes Migration Deployment"

# Validate local migrations first
print_info "Validating migrations locally..."
if ! npm run validate; then
    print_error "Local validation failed. Aborting deployment."
    exit 1
fi
print_success "Local validation passed"

# Create namespace
print_info "Creating namespace ${NAMESPACE}..."
kubectl apply -f k8s/namespace.yaml

# Apply ConfigMap
print_info "Applying ConfigMap..."
kubectl apply -f k8s/configmap.yaml

# Check if secret exists
if ! kubectl get secret mongodb-credentials -n ${NAMESPACE} &>/dev/null; then
    print_error "Secret 'mongodb-credentials' not found in namespace '${NAMESPACE}'"
    print_info "Please create the secret first:"
    print_info "  kubectl create secret generic mongodb-credentials \\"
    print_info "    --from-literal=MONGODB_URL='mongodb://...' \\"
    print_info "    -n ${NAMESPACE}"
    exit 1
fi

# Create ConfigMap from migration files
print_info "Creating migration scripts ConfigMap..."
kubectl create configmap migration-scripts \
    --from-file=package.json \
    --from-file=package-lock.json \
    --from-file=migrate-mongo-config.js \
    --from-file=src/ \
    --from-file=migrations/ \
    --dry-run=client -o yaml | kubectl apply -f - -n ${NAMESPACE}

# Delete existing job if exists
kubectl delete job ${MIGRATION_JOB_NAME} -n ${NAMESPACE} 2>/dev/null || true

# Apply migration job
print_info "Creating migration job..."
kubectl apply -f k8s/migration-job.yaml

# Wait for job to complete
print_header "Monitoring Migration Job"

if wait_for_job ${MIGRATION_JOB_NAME} ${NAMESPACE} ${TIMEOUT}; then
    print_success "Migration completed successfully!"
    
    # Show logs
    print_header "Migration Logs"
    get_job_logs ${MIGRATION_JOB_NAME} ${NAMESPACE}
    
    exit 0
else
    print_error "Migration failed!"
    
    # Show logs
    print_header "Migration Logs"
    get_job_logs ${MIGRATION_JOB_NAME} ${NAMESPACE}
    
    # Ask for rollback
    echo ""
    read -p "Do you want to rollback? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if rollback_migration; then
            print_success "System rolled back successfully"
            exit 1
        else
            print_error "Rollback failed - manual intervention required!"
            exit 2
        fi
    else
        print_info "Skipping rollback"
        exit 1
    fi
fi
