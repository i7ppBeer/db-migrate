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
echo -e "${BLUE}  Database Migration Runner (db-migrate)                ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# Legacy env-based settings, used only when no -c config is given (`wait`)
: ${DB_TYPE:=mongodb}
: ${DB_HOST:=localhost}
: ${DB_PORT:=$([ "$DB_TYPE" = "mongodb" ] && echo "27017" || echo "3306")}
export DB_TYPE DB_HOST DB_PORT

# Config path from the -c argument (set by find_config_arg)
CONFIG_PATH=""

# Wait for database to be ready
# check-db.js reads the same config the command uses (type, host, port,
# credentials — every instance of a multi-instance config), so the wait
# checks the server the command will actually talk to. It used to guess
# the type from the config's *path* (/mariadb/ or /mongodb/ in it), and a
# config at e.g. /app/config/config.js — the k8s Job layout — was waited
# for as MongoDB on localhost until it timed out.
wait_for_database() {
    if [ -n "$CONFIG_PATH" ]; then
        echo -e "\n${BLUE}[WAIT] Waiting for the database(s) in $CONFIG_PATH...${NC}"
    else
        echo -e "\n${BLUE}[WAIT] Waiting for $DB_TYPE at $DB_HOST:$DB_PORT...${NC}"
    fi
    
    local max_attempts=30
    local attempt=1
    local last_error=""
    
    while [ $attempt -le $max_attempts ]; do
        if last_error=$(node /app/src/check-db.js $CONFIG_PATH 2>&1); then
            echo -e "${GREEN}[OK] Database is ready!${NC}"
            return 0
        fi
        
        echo "  Attempt $attempt/$max_attempts - Database not ready, waiting..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}[ERROR] Database connection timeout! Last error: ${last_error}${NC}"
    exit 1
}

# Remember the -c config path, for wait_for_database
find_config_arg() {
    local args=("$@")
    for ((i=0; i<${#args[@]}; i++)); do
        if [[ "${args[i]}" == "-c" && $((i+1)) -lt ${#args[@]} ]]; then
            CONFIG_PATH="${args[$((i+1))]}"
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
            find_config_arg "$@"
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
