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
: ${SANITY_CHECK_ENABLED:=false}
: ${SANITY_CHECK_AUTO_ROLLBACK:=true}
: ${SANITY_CHECK_TIMEOUT:=30000}

echo -e "\n${YELLOW}Configuration:${NC}"
echo "  Database Type: $DB_TYPE"
echo "  Database Host: $DB_HOST:$DB_PORT"
echo "  Database Name: $DB_NAME"
echo "  Config Path:   $CONFIG_PATH"
echo "  Migrations:    $MIGRATIONS_DIR"
echo "  Sanity Check:  $SANITY_CHECK_ENABLED"
if [ "$SANITY_CHECK_ENABLED" = "true" ]; then
    echo "    Auto-Rollback: $SANITY_CHECK_AUTO_ROLLBACK"
    echo "    Timeout:       ${SANITY_CHECK_TIMEOUT}ms"
fi

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
    databaseName: '${DB_NAME}',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  migrationsDir: '${MIGRATIONS_DIR}',
  changelogCollectionName: 'changelog',
  sanityCheck: {
    enabled: ${SANITY_CHECK_ENABLED},
    autoRollback: ${SANITY_CHECK_AUTO_ROLLBACK},
    timeoutMs: ${SANITY_CHECK_TIMEOUT}
  }
};
EOFCONFIG
        else
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
  changelogTable: '_migrations',
  sanityCheck: {
    enabled: ${SANITY_CHECK_ENABLED},
    autoRollback: ${SANITY_CHECK_AUTO_ROLLBACK},
    timeoutMs: ${SANITY_CHECK_TIMEOUT}
  }
};
EOFCONFIG
        fi
        
        echo -e "${GREEN}[OK] Config generated at $CONFIG_PATH${NC}"
    fi
}

# Run the command
run_command() {
    local cmd="$1"
    shift
    
    echo -e "\n${BLUE}[EXEC] db-migrate $cmd${NC}"
    
    local extra_args=()
    
    # Add sanity check flag if enabled
    if [ "$SANITY_CHECK_ENABLED" = "true" ]; then
        extra_args+=("--sanity-check")
        if [ "$SANITY_CHECK_AUTO_ROLLBACK" = "false" ]; then
            extra_args+=("--no-auto-rollback")
        fi
    fi
    
    node /app/src/cli.js -c "$CONFIG_PATH" "$cmd" "${extra_args[@]}" "$@"
}

# Main
main() {
    local command="${1:-up}"
    shift || true
    
    case "$command" in
        wait)
            wait_for_database
            ;;
        up|down|status|validate|test|create)
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
            echo "Available commands: up, down, status, validate, test, create, test-all, wait, help, shell"
            exit 1
            ;;
    esac
}

main "$@"
