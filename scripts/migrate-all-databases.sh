#!/bin/bash

# Multi-Database Migration Script
# Executes migrations for all configured databases

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CONFIGS_DIR="config"
LOG_DIR="logs"

# Create logs directory
mkdir -p "$LOG_DIR"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Multi-Database Migration Runner${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Get list of config files
if [ $# -eq 0 ]; then
  # No arguments - run all configs
  CONFIGS=($(ls -1 ${CONFIGS_DIR}/*.js 2>/dev/null | grep -v "default.js" | grep -v "common.js" || true))
  
  if [ ${#CONFIGS[@]} -eq 0 ]; then
    echo -e "${YELLOW}⚠️  No config files found in ${CONFIGS_DIR}/${NC}"
    echo -e "${YELLOW}Available configs:${NC}"
    ls -1 ${CONFIGS_DIR}/*.js 2>/dev/null || echo "  (none)"
    exit 1
  fi
  
  echo -e "${BLUE}Found ${#CONFIGS[@]} database(s) to migrate:${NC}"
  for config in "${CONFIGS[@]}"; do
    echo -e "  - $(basename $config .js)"
  done
  echo ""
else
  # Specific configs provided
  CONFIGS=("$@")
fi

# Track success/failure
SUCCESS_COUNT=0
FAIL_COUNT=0
FAILED_DBS=()

# Migrate each database
for config_arg in "${CONFIGS[@]}"; do
  # Handle both full paths and just names
  if [[ "$config_arg" == *.js ]]; then
    config="$config_arg"
  else
    config="${CONFIGS_DIR}/${config_arg}.js"
  fi
  
  if [ ! -f "$config" ]; then
    echo -e "${RED}❌ Config not found: $config${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_DBS+=("$config_arg")
    continue
  fi
  
  db_name=$(basename "$config" .js)
  log_file="${LOG_DIR}/${db_name}-$(date +%Y%m%d-%H%M%S).log"
  
  echo -e "${BLUE}=========================================${NC}"
  echo -e "${BLUE}Migrating: ${db_name}${NC}"
  echo -e "${BLUE}=========================================${NC}"
  
  # Run migration
  if node src/cli.js --config "$config" up 2>&1 | tee "$log_file"; then
    echo -e "${GREEN}✅ ${db_name} migration successful${NC}"
    echo ""
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  else
    echo -e "${RED}❌ ${db_name} migration failed${NC}"
    echo -e "${YELLOW}   Log: $log_file${NC}"
    echo ""
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_DBS+=("$db_name")
  fi
done

# Summary
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}Migration Summary${NC}"
echo -e "${BLUE}=========================================${NC}"
echo -e "Total databases: $((SUCCESS_COUNT + FAIL_COUNT))"
echo -e "${GREEN}✅ Successful: ${SUCCESS_COUNT}${NC}"

if [ $FAIL_COUNT -gt 0 ]; then
  echo -e "${RED}❌ Failed: ${FAIL_COUNT}${NC}"
  echo -e "${YELLOW}Failed databases:${NC}"
  for db in "${FAILED_DBS[@]}"; do
    echo -e "${RED}  - $db${NC}"
  done
  echo ""
  exit 1
else
  echo -e "${GREEN}🎉 All databases migrated successfully!${NC}"
  echo ""
  exit 0
fi
