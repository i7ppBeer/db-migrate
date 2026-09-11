#!/bin/bash
# ============================================================
# Migration Runner Entrypoint
# ============================================================

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Database Migration Runner v2.0                        ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# Default values
: ${DB_TYPE:=mongodb}
: ${DB_HOST:=localhost}
: ${DB_PORT:=$([ "$DB_TYPE" = "mongodb" ] && echo "27017" || echo "3306")}
: ${DB_NAME:=migrations}
: ${DB_USER:=}
: ${DB_PASSWORD:=}

echo -e "\n${YELLOW}Configuration:${NC}"
echo "  Database Type: $DB_TYPE"
echo "  Database Host: $DB_HOST:$DB_PORT"
echo "  Database Name: $DB_NAME"

# Wait for database to be ready
wait_for_database() {
    echo -e "\n${BLUE}[WAIT] Waiting for database...${NC}"
    
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        # Test connection using check-db.js
        if node /app/src/check-db.js 2>/dev/null; then
            echo -e "${GREEN}[OK] Database is ready!${NC}"
            return 0
        fi
        
        echo "  Attempt $attempt/$max_attempts - Database not ready, waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}[ERROR] Database connection timeout!${NC}"
    exit 1
}

# Detect DB type and host from -c config path argument
# Sets DB_TYPE / DB_HOST / DB_PORT / DB_USER / DB_PASSWORD
setup_db_from_args() {
    local args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[i]}" == "-c" && $((i+1)) -lt ${#args[@]} ]]; then
            local config_path="${args[$((i+1))]}"
            if [[ "$config_path" == *"/mariadb/"* ]]; then
                export DB_TYPE="mariadb"
                export DB_HOST="${MARIADB_HOST:-mariadb}"
                export DB_PORT="${MARIADB_PORT:-3306}"
                export DB_USER="${MARIADB_USER:-root}"
                export DB_PASSWORD="${MARIADB_PASSWORD:-}"
            elif [[ "$config_path" == *"/mongodb/"* ]]; then
                export DB_TYPE="mongodb"
                export DB_HOST="${MONGODB_HOST:-mongodb}"
                export DB_PORT="${MONGODB_PORT:-27017}"
            fi
            break
        fi
    done
}

# Check if -c parameter is provided (skip for commands that don't need it)
check_config_parameter() {
    local cmd="$1"
    shift
    local args=("$@")
    
    # Commands that don't require -c parameter
    if [[ "$cmd" == "test-all" || "$cmd" == "validate-all" ]]; then
        return 0
    fi
    
    local has_config=false
    
    for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[i]}" == "-c" ]]; then
            has_config=true
            break
        fi
    done
    
    if [ "$has_config" = false ]; then
        echo -e "${RED}[ERROR] Configuration file must be specified using -c parameter${NC}"
        echo -e "${YELLOW}Example: -c /app/config/config.js${NC}"
        exit 1
    fi
}

# Run the command
run_command() {
    local cmd="$1"
    shift
    
    # Check if -c parameter is provided
    check_config_parameter "$cmd" "$@"
    
    echo -e "\n${BLUE}[EXEC] db-migrate $cmd${NC}"
    
    node /app/src/cli.js "$cmd" "$@"
}

# Main
main() {
    local command="${1:-up}"
    shift || true
    
    case "$command" in
        wait)
            wait_for_database
            ;;
        validate-all|validate|test-all|create|create-dcl)
            # These commands only operate on local files, no DB connection needed
            echo -e "\n${BLUE}[INFO] Running $command (no database connection required)${NC}"
            run_command "$command" "$@"
            ;;
        up|down|status|sync|reset|test|baseline|dcl|dcl:status|dcl:verify|status-all|up-all|dcl-all|dcl:status-all|dcl:verify-all|test-instances)
            setup_db_from_args "$@"
            wait_for_database
            run_command "$command" "$@"
            ;;
        help|--help|-h)
            node /app/src/cli.js --help
            ;;
        shell)
            exec /bin/bash
            ;;
        *)
            echo -e "${RED}[ERROR] Unknown command: $command${NC}"
            node /app/src/cli.js --help
            exit 1
            ;;
    esac
}

main "$@"
