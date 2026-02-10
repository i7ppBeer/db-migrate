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
: ${CONFIG_PATH:=/app/config/config.js}
: ${MIGRATIONS_DIR:=/app/migrations}

echo -e "\n${YELLOW}Configuration:${NC}"
echo "  Database Type: $DB_TYPE"
echo "  Database Host: $DB_HOST:$DB_PORT"
echo "  Database Name: $DB_NAME"
echo "  Config Path:   $CONFIG_PATH"
echo "  Migrations:    $MIGRATIONS_DIR"

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

# Generate config if not exists
generate_config() {
    if [ ! -f "$CONFIG_PATH" ]; then
        echo -e "\n${YELLOW}[CONFIG] Generating config file...${NC}"
        
        mkdir -p "$(dirname "$CONFIG_PATH")"
        
        if [ "$DB_TYPE" = "mongodb" ]; then
            # Build MongoDB URL
            local mongo_url="mongodb://${DB_HOST}:${DB_PORT}"
            if [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD" ]; then
                mongo_url="mongodb://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}"
            fi
            
            cat > "$CONFIG_PATH" << EOFCONFIG
export default {
  type: 'mongodb',
  mongodb: {
    url: '${mongo_url}',
    databaseName: '${DB_NAME}'
  },
  migrationsDir: '${MIGRATIONS_DIR}',
  changelogCollection: 'changelog'
};
EOFCONFIG
        else
            # Determine if this is a DCL config (DB_NAME=mysql or MIGRATION_MODE=dcl)
            local migration_mode="${MIGRATION_MODE:-ddl}"
            
            if [ "$DB_NAME" = "mysql" ] || [ "$migration_mode" = "dcl" ]; then
                # DCL config: repeatable mode for user/permission management
                cat > "$CONFIG_PATH" << EOFCONFIG
export default {
  type: 'mariadb',
  mariadb: {
    host: '${DB_HOST}',
    port: ${DB_PORT},
    database: '${DB_NAME:-mysql}',
    user: '${DB_USER:-root}',
    password: '${DB_PASSWORD:-}'
  },
  migrationsDir: '${MIGRATIONS_DIR}',
  checksumTable: '${CHECKSUM_TABLE:-_dcl_migrations}',
  mode: 'repeatable',
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
EOFCONFIG
            else
                # DDL config: versioned mode for schema changes
                cat > "$CONFIG_PATH" << EOFCONFIG
export default {
  type: 'mariadb',
  mariadb: {
    host: '${DB_HOST}',
    port: ${DB_PORT},
    database: '${DB_NAME}',
    user: '${DB_USER:-root}',
    password: '${DB_PASSWORD:-}'
  },
  migrationsDir: '${MIGRATIONS_DIR}',
  changelogTable: '${CHANGELOG_TABLE:-_migrations}',
  sanityCheck: {
    enabled: ${SANITY_CHECK_ENABLED:-false},
    autoRollback: ${SANITY_CHECK_AUTO_ROLLBACK:-true},
    timeoutMs: ${SANITY_CHECK_TIMEOUT:-30000}
  }
};
EOFCONFIG
            fi
        fi
        
        echo -e "${GREEN}[OK] Config generated at $CONFIG_PATH${NC}"
    fi
}

# Run the command
run_command() {
    local cmd="$1"
    shift
    
    echo -e "\n${BLUE}[EXEC] db-migrate $cmd${NC}"
    
    node /app/src/cli.js -c "$CONFIG_PATH" "$cmd" "$@"
}

# Main
main() {
    local command="${1:-up}"
    shift || true
    
    case "$command" in
        wait)
            wait_for_database
            ;;
        up|down|status|validate|test|create|create-dcl|baseline|dcl|dcl:status|dcl:verify|status-all|up-all|dcl-all|dcl:status-all|dcl:verify-all|test-instances)
            wait_for_database
            generate_config
            run_command "$command" "$@"
            ;;
        test-all)
            wait_for_database
            run_command "test-all" "$@"
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
