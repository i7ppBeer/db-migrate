# DCL Migration Test Report

> Generated: 2026-03-20 12:31:22
> MariaDB: 10.6 | Project: ddl-migrate | gen-dcl.py

## Summary

| | Count |
|---|---|
| ✅ Total | 58 |
| ✓ PASS | 58 |
| ✗ FAIL | 0 |

## 帳號生命週期情境

## 前置準備

- MariaDB 10.6 啟動完成 (port 3307)
- 建立 `ecommerce.orders`, `ecommerce.customers`, `analytics.events`, `analytics.summary`
- table-level grant 測試用: customers (ecommerce), summary (analytics)


### 情境 1 (Day 1) — 新增帳號

**故事:** 電商平台上線，建立三個服務帳號，shop_report 僅授權 table-level。

| 結果 | 帳號 | 說明 | 備註 |
|------|------|------|------|
| ✓ PASS | — | 帳號 `shop_api` 存在 | — |
| ✓ PASS | — | 帳號 `shop_report` 存在 | — |
| ✓ PASS | — | 帳號 `shop_ddl` 存在 | — |
| ✓ PASS | `shop_api` | shop_api  ← SELECT ecommerce.orders | — |
| ✓ PASS | `shop_api` | shop_api  ← INSERT ecommerce.orders | — |
| ✓ PASS | `shop_api` | shop_api  ← SELECT ecommerce.customers (db-level grant) | — |
| ✓ PASS | `shop_api` | shop_api  ✗ DROP TABLE (無 DDL 權限) | ERROR 1142 ✓ |
| ✓ PASS | `shop_api` | shop_api  ✗ 存取 analytics (未授權 DB) | ERROR 1044 ✓ |
| ✓ PASS | `shop_api` | shop_api  MAX_QUERIES_PER_HOUR=2000 | MAX_QUERIES_PER_HOUR=2000 |
| ✓ PASS | `shop_api` | shop_api  MAX_USER_CONNECTIONS=10 | MAX_USER_CONNECTIONS=10 |
| ✓ PASS | `shop_report` | shop_report ← SELECT ecommerce.orders (table-level 授權) | — |
| ✓ PASS | `shop_report` | shop_report ✗ SELECT ecommerce.customers (未授權此 table) | ERROR 1142 ✓ |
| ✓ PASS | `shop_report` | shop_report ✗ INSERT ecommerce.orders (只有 SELECT) | ERROR 1142 ✓ |
| ✓ PASS | `shop_report` | shop_report ✗ 存取 analytics (Day1 尚未授權) | ERROR 1044 ✓ |
| ✓ PASS | `shop_ddl` | shop_ddl  ← CREATE TABLE | — |
| ✓ PASS | `shop_ddl` | shop_ddl  ← DROP TABLE | — |
| ✓ PASS | `shop_ddl` | shop_ddl  ← ALTER TABLE | — |
| ✓ PASS | `shop_ddl` | shop_ddl  MAX_USER_CONNECTIONS=3 | MAX_USER_CONNECTIONS=3 |
| ✓ PASS | — | 冪等: R__01 重跑 (CREATE USER IF NOT EXISTS + GRANT 冪等) | 重跑無報錯 |
| ✓ PASS | — | 冪等: R__02 重跑 (CREATE USER IF NOT EXISTS + GRANT 冪等) | 重跑無報錯 |

### 情境 2 (Day 5) — 擴充權限 (table-level)

**故事:** shop_report 需要讀取 analytics.events，以 table-level grant 精準授權。

| 結果 | 帳號 | 說明 | 備註 |
|------|------|------|------|
| ✓ PASS | `shop_report` | shop_report ← SELECT ecommerce.orders (舊授權保留) | — |
| ✓ PASS | `shop_report` | shop_report ✗ SELECT ecommerce.customers (仍未授權) | ERROR 1142 ✓ |
| ✓ PASS | `shop_report` | shop_report ← SELECT analytics.events (新 table-level 授權) | — |
| ✓ PASS | `shop_report` | shop_report ✗ SELECT analytics.summary (未授權此 table) | ERROR 1142 ✓ |
| ✓ PASS | `shop_report` | shop_report ✗ INSERT analytics.events (只有 SELECT) | ERROR 1142 ✓ |
| ✓ PASS | `shop_api` | shop_api  ← INSERT ecommerce (不受影響) | — |
| ✓ PASS | `shop_api` | shop_api  ✗ analytics (仍未授權 DB) | ERROR 1044 ✓ |
| ✓ PASS | `shop_api` | shop_api  MAX_QUERIES_PER_HOUR 仍為 2000 | MAX_QUERIES_PER_HOUR=2000 |
| ✓ PASS | `shop_api` | shop_api  MAX_USER_CONNECTIONS 仍為 10 | MAX_USER_CONNECTIONS=10 |
| ✓ PASS | `shop_ddl` | shop_ddl  MAX_USER_CONNECTIONS 仍為 3 | MAX_USER_CONNECTIONS=3 |
| ✓ PASS | — | 冪等: R__01 重跑 (table-level GRANT 冪等) | 重跑無報錯 |

### 情境 3 (Day 10) — REVOKE + 強制改密碼

**故事:** 安全審計，shop_ddl 撤銷 DROP/ALTER；shop_api 疑似密碼外洩，強制輪換。

| 結果 | 帳號 | 說明 | 備註 |
|------|------|------|------|
| ✓ PASS | `shop_ddl` | shop_ddl ✗ DROP TABLE (已撤銷) | ERROR 1142 ✓ |
| ✓ PASS | `shop_ddl` | shop_ddl ✗ ALTER TABLE (已撤銷) | ERROR 1142 ✓ |
| ✓ PASS | `shop_ddl` | shop_ddl ← CREATE TABLE (CREATE 仍保留) | — |
| ✓ PASS | `shop_ddl` | shop_ddl ← INSERT (DML 仍保留) | — |
| ✓ PASS | `shop_ddl` | shop_ddl  MAX_USER_CONNECTIONS 仍為 3 (revoke 不影響 alter) | MAX_USER_CONNECTIONS=3 |
| ✓ PASS | `shop_api` | shop_api ← 用 OldSecret123 登入 (reset 前有效) | — |
| ✓ PASS | `shop_api` | shop_api ✗ OldSecret123 應已失效 | ERROR 1045 ✓ |
| ✓ PASS | `shop_api` | shop_api ← CHANGE_ME_ON_FIRST_LOGIN 登入 (reset 成功) | — |
| ✓ PASS | `shop_api` | shop_api  MAX_QUERIES_PER_HOUR 仍為 2000 (reset_pwd 不影響) | MAX_QUERIES_PER_HOUR=2000 |
| ✓ PASS | `shop_api` | shop_api  MAX_USER_CONNECTIONS 仍為 10 (reset_pwd 不影響) | MAX_USER_CONNECTIONS=10 |
| ✓ PASS | `shop_report` | shop_report ← analytics.events (不受影響) | — |
| ✓ PASS | — | 冪等: revoke 重跑 (CONTINUE HANDLER FOR 1141) | 重跑無報錯 |
| ✓ PASS | — | 冪等: reset_pwd 重跑 (ALTER USER 冪等) | 重跑無報錯 |

### 情境 4 (Day 30) — 刪除帳號

**故事:** 平台改版，shop_report 退役；shop_ddl 移交 DBA 團隊，兩帳號廢棄。

| 結果 | 帳號 | 說明 | 備註 |
|------|------|------|------|
| ✓ PASS | — | 帳號 `shop_report` 存在 | — |
| ✓ PASS | — | 帳號 `shop_ddl` 存在 | — |
| ✓ PASS | — | 帳號 `shop_report` 已不存在 | — |
| ✓ PASS | — | 帳號 `shop_ddl` 已不存在 | — |
| ✓ PASS | `shop_report` | shop_report ✗ 連線 (帳號已刪) | ERROR 1045 ✓ |
| ✓ PASS | `shop_ddl` | shop_ddl   ✗ 連線 (帳號已刪) | ERROR 1045 ✓ |
| ✓ PASS | — | 帳號 `shop_api` 存在 | — |
| ✓ PASS | `shop_api` | shop_api ← SELECT ecommerce.orders (存活) | — |
| ✓ PASS | `shop_api` | shop_api ← INSERT ecommerce.orders (存活) | — |
| ✓ PASS | `shop_api` | shop_api ← SELECT ecommerce.customers (db-level 仍有效) | — |
| ✓ PASS | `shop_api` | shop_api  MAX_QUERIES_PER_HOUR 仍為 2000 | MAX_QUERIES_PER_HOUR=2000 |
| ✓ PASS | `shop_api` | shop_api  MAX_USER_CONNECTIONS 仍為 10 | MAX_USER_CONNECTIONS=10 |
| ✓ PASS | — | 冪等: drop_user shop_report 重跑 (IF EXISTS) | 重跑無報錯 |
| ✓ PASS | — | 冪等: drop_user shop_ddl   重跑 (IF EXISTS) | 重跑無報錯 |
