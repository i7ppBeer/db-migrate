#!/bin/bash

# Validation Script
# Validates all database configurations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
    echo -e "\n${BLUE}===================================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}===================================================${NC}\n"
}

validate_db() {
    local db_path=$1
    local config_file="$db_path/config.js"
    
    print_header "Validating: $db_path..."
    
    if [ -f "$config_file" ]; then
        node src/cli.js validate -c "$config_file" --allow-dangerous
    else
        echo -e "${RED}[ERROR] Config file not found: $config_file${NC}"
    fi
}

# Validate all databases
validate_db "databases/abc"
validate_db "databases/dangerous_legacy"
validate_db "databases/products"
validate_db "databases/users"

echo -e "\n${GREEN}All validations completed.${NC}\n"
