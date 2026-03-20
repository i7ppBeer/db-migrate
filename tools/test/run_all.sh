#!/usr/bin/env bash
# run_all.sh — 電商平台帳號生命週期端對端測試
#
# 使用方式:
#   bash tools/test/run_all.sh
#   bash tools/test/run_all.sh --no-cleanup   # 跑完保留 container
#   bash tools/test/run_all.sh --scenario 2   # 只跑特定情境 (需先有 DB)
#
# 環境變數:
#   MARIADB_PORT=3307    Docker container 對外 port
#   DCL_OUT=/tmp/...     gen-dcl 輸出目錄
#   REPORT_FILE=/tmp/... Markdown report 路徑

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
export PROJECT_ROOT

# ── 預設值 ────────────────────────────────────────────────────────
export MARIADB_HOST="127.0.0.1"
export MARIADB_PORT="${MARIADB_PORT:-3307}"
export MARIADB_ROOT_PASS="root"
export CONTAINER_NAME="mariadb-dcl-test"
export DCL_OUT="/tmp/dcl-test-out"
export REPORT_FILE="${PROJECT_ROOT}/tools/test/report.md"

# ── 引數解析 ──────────────────────────────────────────────────────
CLEANUP=true
ONLY_SCENARIO=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --no-cleanup)   CLEANUP=false; shift ;;
    --scenario)     ONLY_SCENARIO=$2; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── 顏色 ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${BOLD}[run_all]${RESET} $*"; }
warn() { echo -e "${YELLOW}[run_all] $*${RESET}"; }
fail() { echo -e "${RED}[run_all] ERROR: $*${RESET}"; exit 1; }

# ── source lib (計數器 + report) ──────────────────────────────────
source "${SCRIPT_DIR}/lib.sh"

# ── Cleanup trap ──────────────────────────────────────────────────
cleanup() {
  if [[ "$CLEANUP" == "true" ]]; then
    log "清除 container ${CONTAINER_NAME}..."
    docker stop "${CONTAINER_NAME}" 2>/dev/null || true
    docker rm   "${CONTAINER_NAME}" 2>/dev/null || true
  else
    warn "保留 container (--no-cleanup)：docker stop ${CONTAINER_NAME}"
  fi
  # 還原 accounts.yaml 為 Day 30 最終狀態
  cp "${SCRIPT_DIR}/fixtures/accounts_day30.yaml" \
     "${PROJECT_ROOT}/databases/mariadb/dcl-scenario-test/accounts.yaml" 2>/dev/null || true
}
trap cleanup EXIT

# ════════════════════════════════════════════════════════════════
# 前置準備
# ════════════════════════════════════════════════════════════════
if [[ -z "$ONLY_SCENARIO" ]]; then
  _report "## 前置準備"
  _report ""

  log "啟動 MariaDB 10.6 (port ${MARIADB_PORT})..."

  # 若已存在就先清掉
  docker stop "${CONTAINER_NAME}" 2>/dev/null || true
  docker rm   "${CONTAINER_NAME}" 2>/dev/null || true

  docker run -d \
    --name "${CONTAINER_NAME}" \
    -e MYSQL_ROOT_PASSWORD="${MARIADB_ROOT_PASS}" \
    -p "${MARIADB_PORT}:3306" \
    mariadb:10.6 \
    --character-set-server=utf8mb4 \
    --collation-server=utf8mb4_unicode_ci \
    > /dev/null

  log "等待 MariaDB 就緒..."
  for i in $(seq 1 30); do
    docker exec "${CONTAINER_NAME}" mysql -uroot -p"${MARIADB_ROOT_PASS}" \
      -e "SELECT 1" > /dev/null 2>&1 && break
    [[ $i -eq 30 ]] && fail "MariaDB 啟動逾時"
    sleep 2
  done
  log "✅ MariaDB 就緒"

  # 建立測試 DB 和資料表
  log "建立測試資料庫與資料表..."
  docker exec -i "${CONTAINER_NAME}" mysql -uroot -p"${MARIADB_ROOT_PASS}" <<'SQL'
CREATE DATABASE IF NOT EXISTS ecommerce;
CREATE DATABASE IF NOT EXISTS analytics;

USE ecommerce;
CREATE TABLE IF NOT EXISTS orders (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  amount     DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO orders (id, amount) VALUES (1, 100.00), (2, 200.00);

-- customers table: 用於驗證 table-level grant (shop_report 未授權此表)
CREATE TABLE IF NOT EXISTS customers (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(100)
);
INSERT IGNORE INTO customers (id, name) VALUES (1, 'Alice'), (2, 'Bob');

USE analytics;
CREATE TABLE IF NOT EXISTS events (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  event_name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO events (id, event_name) VALUES (1, 'page_view'), (2, 'purchase');

-- summary table: 用於驗證 table-level grant (shop_report Day5 只授權 events)
CREATE TABLE IF NOT EXISTS summary (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  label    VARCHAR(100),
  total    INT
);
INSERT IGNORE INTO summary (id, label, total) VALUES (1, 'daily', 100);
SQL

  _report "- MariaDB 10.6 啟動完成 (port ${MARIADB_PORT})"
  _report "- 建立 \`ecommerce.orders\`, \`ecommerce.customers\`, \`analytics.events\`, \`analytics.summary\`"
  _report "- table-level grant 測試用: customers (ecommerce), summary (analytics)"
  _report ""
fi

# ── 清空輸出目錄 ──────────────────────────────────────────────────
mkdir -p "${DCL_OUT}"

# ════════════════════════════════════════════════════════════════
# 執行情境
# ════════════════════════════════════════════════════════════════
run_scenario() {
  local num=$1 script=$2
  if [[ -n "$ONLY_SCENARIO" && "$ONLY_SCENARIO" != "$num" ]]; then
    return
  fi
  log "▶ 執行 $script"
  # 傳遞共享 COUNTER_FILE 和 REPORT_BUFFER_FILE 給子 process
  bash "${SCRIPT_DIR}/${script}"
}

run_scenario 1 "scenario_01_add_accounts.sh"
run_scenario 2 "scenario_02_expand_permissions.sh"
run_scenario 3 "scenario_03_revoke_reset_pwd.sh"
run_scenario 4 "scenario_04_drop_users.sh"

# ════════════════════════════════════════════════════════════════
# 生成 Report
# ════════════════════════════════════════════════════════════════
write_report
