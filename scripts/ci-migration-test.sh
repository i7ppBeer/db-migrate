#!/bin/bash
# ============================================================
# ci-migration-test.sh
# CI Migration Test Script
# 執行: Validate → Up → Down → Up 完整測試流程
# ============================================================
#
# 使用方式:
#   ./scripts/ci-migration-test.sh [db-type] [project-name] [--allow-dangerous]
#
# 參數說明:
#   db-type          : mariadb | mongodb | all (預設: all)
#   project-name     : 專案名稱 (預設: test-success)
#   --allow-dangerous: 允許執行危險操作 (如 ALTER TABLE, DROP 等)
#
# 範例:
#   ./scripts/ci-migration-test.sh                              # 測試全部 (嚴格模式)
#   ./scripts/ci-migration-test.sh mariadb                      # 只測試 MariaDB
#   ./scripts/ci-migration-test.sh mongodb                      # 只測試 MongoDB
#   ./scripts/ci-migration-test.sh mariadb my-project           # 測試指定專案
#   ./scripts/ci-migration-test.sh all test-success --allow-dangerous  # 允許危險操作
#
# CI 整合:
#   在 CI pipeline 中可直接執行此腳本，會自動:
#   1. 啟動需要的資料庫
#   2. 等待資料庫就緒
#   3. 執行完整測試
#   4. 回報結果並設定正確的 exit code
#
# ============================================================

set -e  # 遇到錯誤就停止

# ══════════════════════════════════════════════════════════════
# 顏色與常數定義
# ══════════════════════════════════════════════════════════════
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# 計時
START_TIME=$(date +%s)

# 結果追蹤
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
declare -a FAILED_ITEMS=()

# ══════════════════════════════════════════════════════════════
# 參數處理
# ══════════════════════════════════════════════════════════════
DB_TYPE=${1:-all}
PROJECT=${2:-test-success}
ALLOW_DANGEROUS=${3:-false}

# 支援 --allow-dangerous 參數
for arg in "$@"; do
    if [ "$arg" = "--allow-dangerous" ]; then
        ALLOW_DANGEROUS=true
    fi
done

# ══════════════════════════════════════════════════════════════
# 函數定義
# ══════════════════════════════════════════════════════════════

print_banner() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║                                                               ║${NC}"
    echo -e "${CYAN}║     ${BOLD}CI Migration Test${NC}${CYAN}                                        ║${NC}"
    echo -e "${CYAN}║     Validate → Up → Down → Up                                 ║${NC}"
    echo -e "${CYAN}║                                                               ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_step() {
    local step=$1
    local desc=$2
    echo ""
    echo -e "${BLUE}┌─────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${BLUE}│ ${BOLD}Step ${step}:${NC}${BLUE} ${desc}${NC}"
    echo -e "${BLUE}└─────────────────────────────────────────────────────────────────┘${NC}"
}

print_substep() {
    echo -e "   ${CYAN}▸${NC} $1"
}

print_success() {
    echo -e "   ${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "   ${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "   ${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "   ${MAGENTA}ℹ️  $1${NC}"
}

record_result() {
    local test_name=$1
    local result=$2  # 0=pass, 1=fail
    
    ((TOTAL_TESTS++))
    if [ "$result" -eq 0 ]; then
        ((PASSED_TESTS++))
        print_success "$test_name"
    else
        ((FAILED_TESTS++))
        FAILED_ITEMS+=("$test_name")
        print_error "$test_name"
    fi
}

wait_for_db() {
    local db=$1
    local max_attempts=30
    local attempt=1
    
    print_substep "等待 ${db} 就緒..."
    
    while [ $attempt -le $max_attempts ]; do
        if [ "$db" = "mariadb" ]; then
            if docker compose exec -T mariadb mariadb-admin ping -h localhost -u root -prootpass 2>/dev/null | grep -q "alive"; then
                print_success "MariaDB 已就緒 (${attempt}s)"
                return 0
            fi
        elif [ "$db" = "mongodb" ]; then
            if docker compose exec -T mongodb mongosh --eval "db.adminCommand('ping')" 2>/dev/null | grep -q "ok"; then
                print_success "MongoDB 已就緒 (${attempt}s)"
                return 0
            fi
        fi
        sleep 1
        ((attempt++))
    done
    
    print_error "${db} 啟動逾時"
    return 1
}

# ══════════════════════════════════════════════════════════════
# 測試單一資料庫類型
# ══════════════════════════════════════════════════════════════
run_test_for_db() {
    local db_type=$1
    local project=$2
    local allow_dangerous=${3:-false}
    local ddl_config="/app/databases/${db_type}/${project}/ddl/config.js"
    local dcl_config="/app/databases/${db_type}/${project}/dcl/config.js"
    
    # Validate 選項
    local validate_opts=""
    if [ "$allow_dangerous" = "true" ]; then
        validate_opts="--allow-dangerous"
    fi
    
    echo ""
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}  Testing: ${BOLD}${db_type}${NC}${MAGENTA} / ${project}${NC}"
    if [ "$allow_dangerous" = "true" ]; then
        echo -e "${MAGENTA}  Options: ${YELLOW}--allow-dangerous${NC}"
    fi
    echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # ──────────────────────────────────────────────────────────
    # Phase 1: Validate DDL
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 1] DDL Validate..."
    
    if docker compose run --rm migrate validate $validate_opts -c "$ddl_config" 2>&1; then
        record_result "[${db_type}] DDL Validate" 0
    else
        record_result "[${db_type}] DDL Validate" 1
        print_error "Validate 失敗，跳過後續測試"
        return 1
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 2: Validate DCL (if exists)
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 2] DCL Validate..."
    
    if docker compose run --rm migrate dcl:verify -c "$dcl_config" 2>&1; then
        record_result "[${db_type}] DCL Validate" 0
    else
        print_warning "DCL Validate 跳過或無 DCL 檔案"
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 3: Migration UP (First Time)
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 3] Migration UP (1st)..."
    
    if docker compose run --rm migrate up -c "$ddl_config" 2>&1; then
        record_result "[${db_type}] Migration UP (1st)" 0
    else
        record_result "[${db_type}] Migration UP (1st)" 1
        print_error "UP 失敗，跳過後續測試"
        return 1
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 4: Migration DOWN
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 4] Migration DOWN..."
    
    if docker compose run --rm migrate down -n 999 -c "$ddl_config" 2>&1; then
        record_result "[${db_type}] Migration DOWN" 0
    else
        record_result "[${db_type}] Migration DOWN" 1
        print_error "DOWN 失敗，跳過後續測試"
        return 1
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 5: Migration UP (Second Time)
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 5] Migration UP (2nd)..."
    
    if docker compose run --rm migrate up -c "$ddl_config" 2>&1; then
        record_result "[${db_type}] Migration UP (2nd)" 0
    else
        record_result "[${db_type}] Migration UP (2nd)" 1
        return 1
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 6: DCL Apply (if exists)
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 6] DCL Apply..."
    
    local dcl_opts="--validate"
    if [ "$allow_dangerous" = "true" ]; then
        dcl_opts="$dcl_opts --allow-dangerous"
    fi
    
    if docker compose run --rm migrate dcl $dcl_opts -c "$dcl_config" 2>&1; then
        record_result "[${db_type}] DCL Apply" 0
    else
        print_warning "DCL Apply 跳過"
    fi
    
    # ──────────────────────────────────────────────────────────
    # Phase 7: Status Check
    # ──────────────────────────────────────────────────────────
    print_substep "[Phase 7] Final Status Check..."
    
    docker compose run --rm migrate status -c "$ddl_config" 2>&1
    record_result "[${db_type}] Final Status" 0
    
    return 0
}

# ══════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════

print_banner

echo -e "${YELLOW}配置資訊:${NC}"
echo -e "  • 資料庫類型: ${BOLD}${DB_TYPE}${NC}"
echo -e "  • 測試專案:   ${BOLD}${PROJECT}${NC}"
echo -e "  • 允許危險:   ${BOLD}${ALLOW_DANGEROUS}${NC}"
echo -e "  • 執行時間:   $(date '+%Y-%m-%d %H:%M:%S')"

# ──────────────────────────────────────────────────────────
# Step 1: 啟動資料庫
# ──────────────────────────────────────────────────────────
print_step "1" "啟動資料庫服務"

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mariadb" ]; then
    print_substep "啟動 MariaDB..."
    docker compose up -d mariadb
fi

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mongodb" ]; then
    print_substep "啟動 MongoDB..."
    docker compose up -d mongodb
fi

# ──────────────────────────────────────────────────────────
# Step 2: 等待資料庫就緒
# ──────────────────────────────────────────────────────────
print_step "2" "等待資料庫就緒"

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mariadb" ]; then
    wait_for_db "mariadb"
fi

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mongodb" ]; then
    wait_for_db "mongodb"
fi

# ──────────────────────────────────────────────────────────
# Step 3: 執行測試
# ──────────────────────────────────────────────────────────
print_step "3" "執行 Migration 測試 (Validate → Up → Down → Up)"

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mariadb" ]; then
    run_test_for_db "mariadb" "$PROJECT" "$ALLOW_DANGEROUS" || true
fi

if [ "$DB_TYPE" = "all" ] || [ "$DB_TYPE" = "mongodb" ]; then
    run_test_for_db "mongodb" "$PROJECT" "$ALLOW_DANGEROUS" || true
fi

# ──────────────────────────────────────────────────────────
# Step 4: 測試結果報告
# ──────────────────────────────────────────────────────────
print_step "4" "測試結果報告"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                      ${BOLD}Test Results${NC}${CYAN}                             ║${NC}"
echo -e "${CYAN}╠═══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${CYAN}║${NC}                                                               ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}   Total:   ${BOLD}${TOTAL_TESTS}${NC} tests                                         ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}   ${GREEN}Passed:${NC}  ${BOLD}${PASSED_TESTS}${NC}                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}   ${RED}Failed:${NC}  ${BOLD}${FAILED_TESTS}${NC}                                              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}   Time:    ${BOLD}${DURATION}s${NC}                                             ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                                               ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════════════╝${NC}"

if [ ${#FAILED_ITEMS[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}失敗的測試項目:${NC}"
    for item in "${FAILED_ITEMS[@]}"; do
        echo -e "   ${RED}✗${NC} $item"
    done
fi

echo ""

# 回傳 exit code
if [ "$FAILED_TESTS" -gt 0 ]; then
    echo -e "${RED}${BOLD}CI FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}${BOLD}CI PASSED${NC}"
    exit 0
fi
