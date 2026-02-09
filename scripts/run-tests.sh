#!/bin/bash
# ============================================================
# Run All Tests Script
# Executes validation and Up-Down-Up tests for all databases
# Generates HTML/JSON reports
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPORTS_DIR="${PROJECT_DIR}/reports"

print_header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
}

# Create reports directory
mkdir -p "$REPORTS_DIR"

# Start time
START_TIME=$(date +%s)

print_header "Database Migration Test Suite"

echo -e "${YELLOW}Project:${NC} $PROJECT_DIR"
echo -e "${YELLOW}Reports:${NC} $REPORTS_DIR"
echo ""

# ============================================================
# Check if databases are running
# ============================================================
print_header "Checking Database Connections"

MONGO_UP=false
MARIADB_UP=false

# Check MongoDB
if command -v mongosh &> /dev/null; then
    if mongosh --host localhost --port 27017 --eval "db.runCommand('ping')" --quiet 2>/dev/null; then
        echo -e "${GREEN}✓ MongoDB is running${NC}"
        MONGO_UP=true
    else
        echo -e "${YELLOW}⚠ MongoDB not available at localhost:27017${NC}"
    fi
else
    echo -e "${YELLOW}⚠ mongosh not installed, skipping MongoDB tests${NC}"
fi

# Check MariaDB
if command -v mysql &> /dev/null; then
    if mysql -h localhost -P 3306 -u root -p"${MARIADB_ROOT_PASSWORD:-rootpass}" -e "SELECT 1" 2>/dev/null; then
        echo -e "${GREEN}✓ MariaDB is running${NC}"
        MARIADB_UP=true
    else
        echo -e "${YELLOW}⚠ MariaDB not available at localhost:3306${NC}"
    fi
else
    echo -e "${YELLOW}⚠ mysql client not installed, skipping MariaDB tests${NC}"
fi

# ============================================================
# Run MongoDB Tests
# ============================================================
if [ "$MONGO_UP" = true ]; then
    print_header "MongoDB Tests"
    
    for test_dir in "$PROJECT_DIR/databases/mongodb"/*/; do
        test_name=$(basename "$test_dir")
        config_file="${test_dir}config.js"
        
        if [ -f "$config_file" ]; then
            echo -e "\n${BLUE}Testing: ${test_name}${NC}"
            echo "  Config: $config_file"
            
            # Run validation
            echo -e "  ${YELLOW}→ Running validation...${NC}"
            if node "$PROJECT_DIR/src/cli.js" -c "$config_file" validate 2>&1; then
                echo -e "  ${GREEN}✓ Validation passed${NC}"
            else
                echo -e "  ${RED}✗ Validation failed${NC}"
            fi
            
            # Run Up-Down-Up test (only for success tests)
            if [[ "$test_name" == *"success"* ]]; then
                echo -e "  ${YELLOW}→ Running Up-Down-Up test...${NC}"
                if node "$PROJECT_DIR/src/cli.js" -c "$config_file" test 2>&1; then
                    echo -e "  ${GREEN}✓ Up-Down-Up test passed${NC}"
                else
                    echo -e "  ${RED}✗ Up-Down-Up test failed${NC}"
                fi
            fi
        fi
    done
fi

# ============================================================
# Run MariaDB Tests
# ============================================================
if [ "$MARIADB_UP" = true ]; then
    print_header "MariaDB Tests"
    
    for test_dir in "$PROJECT_DIR/databases/mariadb"/*/; do
        test_name=$(basename "$test_dir")
        config_file="${test_dir}config.js"
        
        if [ -f "$config_file" ]; then
            echo -e "\n${BLUE}Testing: ${test_name}${NC}"
            echo "  Config: $config_file"
            
            # Run validation
            echo -e "  ${YELLOW}→ Running validation...${NC}"
            if node "$PROJECT_DIR/src/cli.js" -c "$config_file" validate 2>&1; then
                echo -e "  ${GREEN}✓ Validation passed${NC}"
            else
                echo -e "  ${RED}✗ Validation failed${NC}"
            fi
            
            # Run Up-Down-Up test (only for success tests)
            if [[ "$test_name" == *"success"* ]]; then
                echo -e "  ${YELLOW}→ Running Up-Down-Up test...${NC}"
                if node "$PROJECT_DIR/src/cli.js" -c "$config_file" test 2>&1; then
                    echo -e "  ${GREEN}✓ Up-Down-Up test passed${NC}"
                else
                    echo -e "  ${RED}✗ Up-Down-Up test failed${NC}"
                fi
            fi
        fi
    done
fi

# ============================================================
# Generate Summary Report
# ============================================================
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_header "Test Summary"

REPORT_FILE="$REPORTS_DIR/test-report-$(date +%Y%m%d-%H%M%S).txt"

{
    echo "Database Migration Test Report"
    echo "=============================="
    echo "Date: $(date)"
    echo "Duration: ${DURATION}s"
    echo ""
    echo "Database Status:"
    echo "  MongoDB:  $([ "$MONGO_UP" = true ] && echo "Available" || echo "Not Available")"
    echo "  MariaDB:  $([ "$MARIADB_UP" = true ] && echo "Available" || echo "Not Available")"
    echo ""
} | tee "$REPORT_FILE"

echo -e "\n${GREEN}Report saved to: $REPORT_FILE${NC}"

# ============================================================
# Docker-based full test (optional)
# ============================================================
if [ "$1" = "--docker" ]; then
    print_header "Running Docker-based Tests"
    
    echo "Starting test environment..."
    docker compose -f "$PROJECT_DIR/docker-compose.yml" up -d mongodb mariadb
    
    echo "Waiting for databases to be ready..."
    sleep 10
    
    echo "Running test-all job..."
    docker compose -f "$PROJECT_DIR/docker-compose.yml" run --rm test-all
    
    echo "Copying reports..."
    docker cp migrate-test-all:/app/reports/. "$REPORTS_DIR/" 2>/dev/null || true
    
    echo "Cleaning up..."
    docker compose -f "$PROJECT_DIR/docker-compose.yml" down
    
    echo -e "\n${GREEN}Docker tests completed!${NC}"
fi

print_header "Done!"
echo -e "${GREEN}Total duration: ${DURATION}s${NC}"
