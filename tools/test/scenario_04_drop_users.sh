#!/usr/bin/env bash
# scenario_04_drop_users.sh
# 情境 4 (Day 30): 廢棄 shop_report 與 shop_ddl
#
# 測試重點:
#   - drop_user 產生正確 SQL
#   - 帳號刪除後連線被拒
#   - shop_api 存活，alter limits 仍有效
#   - DROP USER IF EXISTS 冪等

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

SCENARIO="情境 4 (Day 30) — 刪除帳號"
section "$SCENARIO"
_report "**故事:** 平台改版，shop_report 退役；shop_ddl 移交 DBA 團隊，兩帳號廢棄。"
_report ""
report_table_header

# ── 確認套用前帳號都存在 ──────────────────────────────────────────
assert_user_exists "shop_report"
assert_user_exists "shop_ddl"

# ── 產生 & 套用 DCL ───────────────────────────────────────────────
gen_dcl "${SCRIPT_DIR}/fixtures/accounts_day30.yaml"

FILE_DROP_REPORT=$(ls "${DCL_OUT}/"R__*_drop_user_shop_report.sql 2>/dev/null | head -1)
FILE_DROP_DDL=$(ls    "${DCL_OUT}/"R__*_drop_user_shop_ddl.sql    2>/dev/null | head -1)
[[ -z "$FILE_DROP_REPORT" ]] && { echo "ERROR: drop_user shop_report not found"; exit 1; }
[[ -z "$FILE_DROP_DDL"    ]] && { echo "ERROR: drop_user shop_ddl not found";    exit 1; }

apply_dcl "$FILE_DROP_REPORT"
apply_dcl "$FILE_DROP_DDL"

# ── 帳號已消失 ────────────────────────────────────────────────────
assert_user_not_exists "shop_report"
assert_user_not_exists "shop_ddl"

# ── 連線被拒 ──────────────────────────────────────────────────────
assert_fails "shop_report ✗ 連線 (帳號已刪)" 1045 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT 1;"

assert_fails "shop_ddl   ✗ 連線 (帳號已刪)" 1045 \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT 1;"

# ── shop_api 存活，權限與 alter limits 完整 ────────────────────────
assert_user_exists "shop_api"

assert_succeeds "shop_api ← SELECT ecommerce.orders (存活)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM orders;"

assert_succeeds "shop_api ← INSERT ecommerce.orders (存活)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "INSERT INTO orders (amount) VALUES (500.00);"

assert_succeeds "shop_api ← SELECT ecommerce.customers (db-level 仍有效)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM customers;"

assert_resource_limit "shop_api  MAX_QUERIES_PER_HOUR 仍為 2000" \
  shop_api MAX_QUERIES_PER_HOUR 2000

assert_resource_limit "shop_api  MAX_USER_CONNECTIONS 仍為 10" \
  shop_api MAX_USER_CONNECTIONS 10

# ── 冪等：DROP USER IF EXISTS 重跑不報錯 ─────────────────────────
assert_idempotent "drop_user shop_report 重跑 (IF EXISTS)" "$FILE_DROP_REPORT"
assert_idempotent "drop_user shop_ddl   重跑 (IF EXISTS)" "$FILE_DROP_DDL"
