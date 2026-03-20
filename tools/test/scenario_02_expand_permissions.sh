#!/usr/bin/env bash
# scenario_02_expand_permissions.sh
# 情境 2 (Day 5): shop_report 擴充授權到 analytics.events (table-level)
#
# 測試重點:
#   - shop_report 新增 SELECT ON analytics.events
#   - 仍只有 table-level: analytics.summary 未授權
#   - ecommerce.customers 仍未授權
#   - shop_api / shop_ddl 不受影響 (含 alter limits)
#   - 冪等測試

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

SCENARIO="情境 2 (Day 5) — 擴充權限 (table-level)"
section "$SCENARIO"
_report "**故事:** shop_report 需要讀取 analytics.events，以 table-level grant 精準授權。"
_report ""
report_table_header

# ── 產生 & 套用 DCL ───────────────────────────────────────────────
gen_dcl "${SCRIPT_DIR}/fixtures/accounts_day05.yaml"
apply_dcl "${DCL_OUT}/R__01_shop_service_accounts.sql"

# ── shop_report: ecommerce.orders 仍可存取 ────────────────────────
assert_succeeds "shop_report ← SELECT ecommerce.orders (舊授權保留)" \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM orders;"

assert_fails    "shop_report ✗ SELECT ecommerce.customers (仍未授權)" 1142 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT COUNT(*) FROM customers;"

# ── shop_report: analytics.events 新授權 ─────────────────────────
assert_succeeds "shop_report ← SELECT analytics.events (新 table-level 授權)" \
  shop_report CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT COUNT(*) FROM events;"

assert_fails    "shop_report ✗ SELECT analytics.summary (未授權此 table)" 1142 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT COUNT(*) FROM summary;"

assert_fails    "shop_report ✗ INSERT analytics.events (只有 SELECT)" 1142 \
  shop_report CHANGE_ME_ON_FIRST_LOGIN analytics \
  "INSERT INTO events (event_name) VALUES ('hack');"

# ── shop_api: 不受影響 (含 alter limits) ─────────────────────────
assert_succeeds "shop_api  ← INSERT ecommerce (不受影響)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "INSERT INTO orders (amount) VALUES (200.00);"

assert_fails    "shop_api  ✗ analytics (仍未授權 DB)" 1044 \
  shop_api CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT 1;"

assert_resource_limit "shop_api  MAX_QUERIES_PER_HOUR 仍為 2000" \
  shop_api MAX_QUERIES_PER_HOUR 2000

assert_resource_limit "shop_api  MAX_USER_CONNECTIONS 仍為 10" \
  shop_api MAX_USER_CONNECTIONS 10

# ── shop_ddl: 不受影響 ───────────────────────────────────────────
assert_resource_limit "shop_ddl  MAX_USER_CONNECTIONS 仍為 3" \
  shop_ddl MAX_USER_CONNECTIONS 3

# ── 冪等：GRANT 重跑不報錯 ────────────────────────────────────────
assert_idempotent "R__01 重跑 (table-level GRANT 冪等)" \
  "${DCL_OUT}/R__01_shop_service_accounts.sql"
