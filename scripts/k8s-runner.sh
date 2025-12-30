#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }

# Check inputs
if [ -z "$DB_NAMES" ]; then
    echo "Error: DB_NAMES environment variable is not set."
    exit 1
fi

IFS=',' read -ra DBS <<< "$DB_NAMES"

CMD="up"
if [ "$DRY_RUN" = "true" ]; then
    log_info "Dry run mode enabled"
    CMD="up --dry-run"
fi

for DB in "${DBS[@]}"; do
    log_info "Processing database: $DB"
    
    CONFIG_FILE="databases/$DB/config.js"
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "Error: Config file $CONFIG_FILE not found."
        exit 1
    fi

    # Construct the env var name for the connection string
    # Convention: DB_{NAME}_URL (uppercase)
    # Bash 4.0+ for uppercase. If not available, use tr.
    VAR_NAME="DB_$(echo "$DB" | tr '[:lower:]' '[:upper:]')_URL"
    
    DB_URL="${!VAR_NAME}"
    
    if [ -z "$DB_URL" ]; then
        echo "Warning: $VAR_NAME is not set. Using default from config or process.env."
    else
        export MONGODB_URL="$DB_URL"
        log_info "Set MONGODB_URL from $VAR_NAME"
    fi

    log_info "Running migration for $DB..."
    node src/cli.js $CMD -c "$CONFIG_FILE"
    log_success "Migration step complete for $DB"
done

log_success "All operations completed."
