#!/bin/bash
# ============================================================
# Smoke Test — production-server DCL + DDL
# ============================================================
#
# 測試矩陣（每次修改後執行）:
#
#   MariaDB DCL  : dcl:status → dcl → dcl:verify → dcl:verify-all
#   MariaDB DDL  : validate → status → up → down → up (ecommerce / analytics / logging)
#   MongoDB  DCL : dcl:status → dcl → dcl:verify → dcl:verify-all
#   MongoDB  DDL : validate → status → up → down -n 3 → up
#   全域         : validate-all (mongodb + mariadb)
#
# 使用方式:
#   ./scripts/smoke-test.sh
#
#   可以用環境變數覆寫連線資訊:
#   MARIADB_USER=root MARIADB_PASSWORD=rootpass \
#   MONGODB_URL=mongodb://localhost:27017 \
#   ./scripts/smoke-test.sh
#
# ============================================================

set -euo pipefail

# ─── 顏色 ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

# ─── 環境變數預設值 ────────────────────────────────────────
export MARIADB_USER="${MARIADB_USER:-root}"
export MARIADB_PASSWORD="${MARIADB_PASSWORD:-rootpass}"
export MONGODB_URL="${MONGODB_URL:-mongodb://localhost:27017}"
export MONGODB_DATABASE="${MONGODB_DATABASE:-ecommerce}"

# ─── 路徑設定 ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLI="node $PROJECT_DIR/src/cli.js"

MONGO_PRODUCTION="$PROJECT_DIR/test-fixtures/mongodb/production-server"
MARIA_PRODUCTION="$PROJECT_DIR/test-fixtures/mariadb/production-server"

# ─── 計數器 ───────────────────────────────────────────────
PASSED=0
FAILED=0
ERRORS=()

# ─── 工具函式 ─────────────────────────────────────────────

print_header() {
    echo -e "\n${BLUE}════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
}

print_section() {
    echo -e "\n${CYAN}── $1 ──${NC}"
}

run_cmd() {
    local label="$1"
    shift
    echo -e "\n${YELLOW}▶ $label${NC}"
    echo -e "${GRAY}  $ $*${NC}"
    if "$@"; then
        echo -e "${GREEN}  ✅ PASSED: $label${NC}"
        PASSED=$((PASSED + 1))
    else
        echo -e "${RED}  ❌ FAILED: $label${NC}"
        FAILED=$((FAILED + 1))
        ERRORS+=("$label")
        # 繼續執行其他測試（不因單項失敗中止）
        return 0
    fi
}

check_container() {
    local name="$1"
    local status
    status=$(docker inspect "$name" --format='{{.State.Health.Status}}' 2>/dev/null || echo "not_found")
    if [[ "$status" == "healthy" ]]; then
        echo -e "${GREEN}  ✓ $name is healthy${NC}"
        return 0
    else
        echo -e "${RED}  ✗ $name is not healthy (status: $status)${NC}"
        return 1
    fi
}

# ─── 開始 ─────────────────────────────────────────────────
START_TIME=$(date +%s)
print_header "Smoke Test — production-server ($(date '+%Y-%m-%d %H:%M:%S'))"

# ─── 容器狀態確認 ─────────────────────────────────────────
print_section "Container Health Check"
MONGO_OK=true
MARIA_OK=true

check_container "migrate-mongodb" || MONGO_OK=false
check_container "migrate-mariadb" || MARIA_OK=false

if [[ "$MONGO_OK" == "false" && "$MARIA_OK" == "false" ]]; then
    echo -e "${RED}\n  No healthy DB containers found. Aborting.${NC}"
    echo -e "${GRAY}  Use: docker-compose up -d mongodb mariadb${NC}"
    exit 1
fi

# ═══════════════════════════════════════════════════════════
# MARIADB
# ═══════════════════════════════════════════════════════════
if [[ "$MARIA_OK" == "true" ]]; then

    print_header "MariaDB — DCL"

    print_section "dcl:status"
    run_cmd "MariaDB dcl:status" \
        $CLI dcl:status -c "$MARIA_PRODUCTION/dcl/config.js"

    print_section "dcl"
    run_cmd "MariaDB dcl run" \
        $CLI dcl -c "$MARIA_PRODUCTION/dcl/config.js"

    print_section "dcl:verify"
    run_cmd "MariaDB dcl:verify" \
        $CLI dcl:verify -c "$MARIA_PRODUCTION/dcl/config.js"

    print_section "dcl:verify-all"
    run_cmd "MariaDB dcl:verify-all" \
        $CLI dcl:verify-all -c "$MARIA_PRODUCTION/dcl/config.js"

    # ─────────────────────────────────────────────────────
    # MariaDB DDL — ecommerce
    # ─────────────────────────────────────────────────────
    print_header "MariaDB — DDL [ecommerce]"

    run_cmd "MariaDB ecommerce validate" \
        $CLI validate -c "$MARIA_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MariaDB ecommerce status" \
        $CLI status -c "$MARIA_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MariaDB ecommerce up" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MariaDB ecommerce down -n 3" \
        $CLI down -n 3 -c "$MARIA_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MariaDB ecommerce up (re-apply)" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/ecommerce/config.js"

    # ─────────────────────────────────────────────────────
    # MariaDB DDL — analytics
    # ─────────────────────────────────────────────────────
    print_header "MariaDB — DDL [analytics]"

    run_cmd "MariaDB analytics validate" \
        $CLI validate -c "$MARIA_PRODUCTION/ddl/analytics/config.js"

    run_cmd "MariaDB analytics status" \
        $CLI status -c "$MARIA_PRODUCTION/ddl/analytics/config.js"

    run_cmd "MariaDB analytics up" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/analytics/config.js"

    run_cmd "MariaDB analytics down -n 5" \
        $CLI down -n 5 -c "$MARIA_PRODUCTION/ddl/analytics/config.js"

    run_cmd "MariaDB analytics up (re-apply)" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/analytics/config.js"

    # ─────────────────────────────────────────────────────
    # MariaDB DDL — logging
    # ─────────────────────────────────────────────────────
    print_header "MariaDB — DDL [logging]"

    run_cmd "MariaDB logging validate" \
        $CLI validate -c "$MARIA_PRODUCTION/ddl/logging/config.js"

    run_cmd "MariaDB logging status" \
        $CLI status -c "$MARIA_PRODUCTION/ddl/logging/config.js"

    run_cmd "MariaDB logging up" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/logging/config.js"

    run_cmd "MariaDB logging down -n 3" \
        $CLI down -n 3 -c "$MARIA_PRODUCTION/ddl/logging/config.js"

    run_cmd "MariaDB logging up (re-apply)" \
        $CLI up -c "$MARIA_PRODUCTION/ddl/logging/config.js"

    # ─────────────────────────────────────────────────────
    # validate-all MariaDB (DDL + DCL)
    # ─────────────────────────────────────────────────────
    print_header "MariaDB — validate-all"

    run_cmd "MariaDB validate-all" \
        $CLI validate-all "$MARIA_PRODUCTION"

fi  # MARIA_OK

# ═══════════════════════════════════════════════════════════
# MONGODB
# ═══════════════════════════════════════════════════════════
if [[ "$MONGO_OK" == "true" ]]; then

    print_header "MongoDB — DCL"

    print_section "dcl:status"
    run_cmd "MongoDB dcl:status" \
        $CLI dcl:status -c "$MONGO_PRODUCTION/dcl/config.js"

    print_section "dcl"
    run_cmd "MongoDB dcl run" \
        $CLI dcl -c "$MONGO_PRODUCTION/dcl/config.js"

    print_section "dcl:verify"
    run_cmd "MongoDB dcl:verify" \
        $CLI dcl:verify -c "$MONGO_PRODUCTION/dcl/config.js"

    print_section "dcl:verify-all"
    run_cmd "MongoDB dcl:verify-all" \
        $CLI dcl:verify-all -c "$MONGO_PRODUCTION/dcl/config.js"

    # ─────────────────────────────────────────────────────
    # MongoDB DDL — ecommerce
    # ─────────────────────────────────────────────────────
    print_header "MongoDB — DDL [ecommerce]"

    run_cmd "MongoDB ecommerce validate" \
        $CLI validate -c "$MONGO_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MongoDB ecommerce status" \
        $CLI status -c "$MONGO_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MongoDB ecommerce up" \
        $CLI up -c "$MONGO_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MongoDB ecommerce down -n 3" \
        $CLI down -n 3 -c "$MONGO_PRODUCTION/ddl/ecommerce/config.js"

    run_cmd "MongoDB ecommerce up (re-apply)" \
        $CLI up -c "$MONGO_PRODUCTION/ddl/ecommerce/config.js"

    # ─────────────────────────────────────────────────────
    # validate-all MongoDB (DDL + DCL)
    # ─────────────────────────────────────────────────────
    print_header "MongoDB — validate-all"

    run_cmd "MongoDB validate-all" \
        $CLI validate-all "$MONGO_PRODUCTION"

fi  # MONGO_OK

# ═══════════════════════════════════════════════════════════
# UNIT TESTS
# ═══════════════════════════════════════════════════════════
print_header "Unit Tests"

run_cmd "npm test (vitest)" \
    npm --prefix "$PROJECT_DIR" test -- run

# ─── 結果摘要 ─────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

print_header "Summary"
echo -e "  Duration : ${DURATION}s"
echo -e "  ${GREEN}Passed   : $PASSED${NC}"
echo -e "  ${RED}Failed   : $FAILED${NC}"

if [[ ${#ERRORS[@]} -gt 0 ]]; then
    echo -e "\n${RED}Failed items:${NC}"
    for err in "${ERRORS[@]}"; do
        echo -e "  ${RED}• $err${NC}"
    done
    echo ''
    exit 1
else
    echo -e "\n${GREEN}🎉 All tests passed!${NC}\n"
    exit 0
fi
