#!/usr/bin/env bash
# scenario_03_revoke_reset_pwd.sh
# 情境 3 (Day 10): 安全審計
#   - shop_ddl: REVOKE DROP, ALTER ON ecommerce.* (新格式 list revoke)
#   - shop_api: reset_pwd 強制密碼輪換
#
# 測試重點:
#   - revoke 新格式 list [{privileges, on}] 正確產生
#   - shop_ddl: DROP/ALTER 已撤銷，CREATE/SELECT/INSERT 仍保留
#   - shop_api: 舊密碼失效，新密碼生效
#   - alter limits 不受影響
#   - CONTINUE HANDLER FOR 1141 冪等測試

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

SCENARIO="情境 3 (Day 10) — REVOKE + 強制改密碼"
section "$SCENARIO"
_report "**故事:** 安全審計，shop_ddl 撤銷 DROP/ALTER；shop_api 疑似密碼外洩，強制輪換。"
_report ""
report_table_header

# ── 產生 & 套用 DCL ───────────────────────────────────────────────
gen_dcl "${SCRIPT_DIR}/fixtures/accounts_day10.yaml"
apply_dcl "${DCL_OUT}/R__01_shop_service_accounts.sql"
apply_dcl "${DCL_OUT}/R__02_shop_ddl_admin.sql"

FILE_REVOKE=$(ls "${DCL_OUT}/"R__*_revoke_shop_ddl.sql 2>/dev/null | head -1)
FILE_RESET=$(ls  "${DCL_OUT}/"R__*_reset_pwd_shop_api.sql 2>/dev/null | head -1)
[[ -z "$FILE_REVOKE" ]] && { echo "ERROR: R__*_revoke_shop_ddl.sql not found in ${DCL_OUT}"; exit 1; }
[[ -z "$FILE_RESET"  ]] && { echo "ERROR: R__*_reset_pwd_shop_api.sql not found in ${DCL_OUT}"; exit 1; }
apply_dcl "$FILE_REVOKE"
apply_dcl "$FILE_RESET"

# ── REVOKE 驗證: shop_ddl 不再有 DROP / ALTER ────────────────────
assert_fails    "shop_ddl ✗ DROP TABLE (已撤銷)" 1142 \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "DROP TABLE orders;"

assert_fails    "shop_ddl ✗ ALTER TABLE (已撤銷)" 1142 \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "ALTER TABLE orders ADD COLUMN test_col INT;"

# CREATE 未撤銷，應仍可用
assert_succeeds "shop_ddl ← CREATE TABLE (CREATE 仍保留)" \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "CREATE TABLE IF NOT EXISTS tmp_s03 (id INT);"
mysql_root "DROP TABLE IF EXISTS ecommerce.tmp_s03;" 2>/dev/null || true

assert_succeeds "shop_ddl ← INSERT (DML 仍保留)" \
  shop_ddl CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "INSERT INTO orders (amount) VALUES (1.00);"

# ── alter limits: shop_ddl 仍保留 ────────────────────────────────
assert_resource_limit "shop_ddl  MAX_USER_CONNECTIONS 仍為 3 (revoke 不影響 alter)" \
  shop_ddl MAX_USER_CONNECTIONS 3

# ── reset_pwd 驗證: shop_api 密碼已重置 ──────────────────────────
step "將 shop_api 密碼暫改為 OldSecret123 (模擬已使用中的密碼)"
mysql_root "ALTER USER 'shop_api'@'%' IDENTIFIED BY 'OldSecret123';" 2>/dev/null

assert_succeeds "shop_api ← 用 OldSecret123 登入 (reset 前有效)" \
  shop_api OldSecret123 ecommerce \
  "SELECT 'before-reset' AS s;"

step "套用 reset_pwd 檔案"
apply_dcl "$FILE_RESET"

assert_fails    "shop_api ✗ OldSecret123 應已失效" 1045 \
  shop_api OldSecret123 ecommerce \
  "SELECT 1;"

assert_succeeds "shop_api ← CHANGE_ME_ON_FIRST_LOGIN 登入 (reset 成功)" \
  shop_api CHANGE_ME_ON_FIRST_LOGIN ecommerce \
  "SELECT 'after-reset' AS s;"

# ── shop_api alter limits 不受 reset_pwd 影響 ────────────────────
assert_resource_limit "shop_api  MAX_QUERIES_PER_HOUR 仍為 2000 (reset_pwd 不影響)" \
  shop_api MAX_QUERIES_PER_HOUR 2000

assert_resource_limit "shop_api  MAX_USER_CONNECTIONS 仍為 10 (reset_pwd 不影響)" \
  shop_api MAX_USER_CONNECTIONS 10

# ── shop_report 不受影響 ──────────────────────────────────────────
assert_succeeds "shop_report ← analytics.events (不受影響)" \
  shop_report CHANGE_ME_ON_FIRST_LOGIN analytics \
  "SELECT COUNT(*) FROM events;"

# ── 冪等：CONTINUE HANDLER FOR 1141 確保重跑不報錯 ───────────────
assert_idempotent "revoke 重跑 (CONTINUE HANDLER FOR 1141)" "$FILE_REVOKE"
assert_idempotent "reset_pwd 重跑 (ALTER USER 冪等)" "$FILE_RESET"
