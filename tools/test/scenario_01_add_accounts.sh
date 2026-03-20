#!/usr/bin/env bash
# scenario_01_add_accounts.sh
# 情境 1 (Day 1): 新增三個電商服務帳號
#
# 測試重點:
#   - shop_api   : db-level DML (ecommerce.*) + alter resource limits
#   - shop_report: table-level SELECT (ecommerce.orders 只，customers 未授權)
#   - shop_ddl   : db-level 完整 DDL + alter MAX_USER_CONNECTIONS
#   - 冪等測試

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

SCENARIO="情境 1 (Day 1) — 新增帳號"
section "$SCENARIO"
_report "**故事:** 電商平台上線，建立三個服務帳號，shop_report 僅授權 table-level。"
_report ""
report_table_header

# ── 產生 & 套用 DCL ───────────────────────────────────────────────
gen_dcl "${SCRIPT_DIR}/fixtures/accounts_day01.yaml"
apply_dcl "${DCL_OUT}/R__01_shop_service_accounts.sql"
apply_dcl "${DCL_OUT}/R__02_shop_ddl_admin.sql"

# ── 帳號存在驗證 ───────────────────────────────────────────────────
assert_user_exists "shop_api"
assert_user_exists "shop_report"
assert_user_exists "shop_ddl"

# ── shop_api: db-level DML ────────────────────────────────────────
assert_succeeds "shop_api  ← SELECT ecommerce.orders" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM orders;"

assert_succeeds "shop_api  ← INSERT ecommerce.orders" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "INSERT INTO orders (amount) VALUES (100.00);"

assert_succeeds "shop_api  ← SELECT ecommerce.customers (db-level grant)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM customers;"

assert_fails    "shop_api  ✗ DROP TABLE (無 DDL 權限)" 1142 \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "DROP TABLE orders;"

assert_fails    "shop_api  ✗ 存取 analytics (未授權 DB)" 1044 \
  shop_api CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT 1;"

# ── shop_api: ALTER resource limits 驗證 ─────────────────────────
assert_resource_limit "shop_api  MAX_QUERIES_PER_HOUR=2000" \
  shop_api MAX_QUERIES_PER_HOUR 2000

assert_resource_limit "shop_api  MAX_USER_CONNECTIONS=10" \
  shop_api MAX_USER_CONNECTIONS 10

# ── shop_report: table-level SELECT ecommerce.orders ─────────────
assert_succeeds "shop_report ← SELECT ecommerce.orders (table-level 授權)" \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM orders;"

assert_fails    "shop_report ✗ SELECT ecommerce.customers (未授權此 table)" 1142 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM customers;"

assert_fails    "shop_report ✗ INSERT ecommerce.orders (只有 SELECT)" 1142 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "INSERT INTO orders (amount) VALUES (999);"

assert_fails    "shop_report ✗ 存取 analytics (Day1 尚未授權)" 1044 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT 1;"

# ── shop_ddl: 完整 DDL ────────────────────────────────────────────
assert_succeeds "shop_ddl  ← CREATE TABLE" \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "CREATE TABLE IF NOT EXISTS tmp_s01 (id INT);"

assert_succeeds "shop_ddl  ← DROP TABLE" \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "DROP TABLE IF EXISTS tmp_s01;"

assert_succeeds "shop_ddl  ← ALTER TABLE" \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS flag TINYINT DEFAULT 0;"

# 清除 ALTER 影響
mysql_root "ALTER TABLE ecommerce.orders DROP COLUMN IF EXISTS flag;" 2>/dev/null || true

# ── shop_ddl: ALTER resource limits 驗證 ─────────────────────────
assert_resource_limit "shop_ddl  MAX_USER_CONNECTIONS=3" \
  shop_ddl MAX_USER_CONNECTIONS 3

# ── 冪等：重跑不報錯 ──────────────────────────────────────────────
assert_idempotent "R__01 重跑 (CREATE USER IF NOT EXISTS + GRANT 冪等)" \
  "${DCL_OUT}/R__01_shop_service_accounts.sql"
assert_idempotent "R__02 重跑 (CREATE USER IF NOT EXISTS + GRANT 冪等)" \
  "${DCL_OUT}/R__02_shop_ddl_admin.sql"
