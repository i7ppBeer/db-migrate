-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users (公版範本)
--
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 CREATE USER IF NOT EXISTS 模式，不影響已存在的帳號
--
-- 用途:
--   - 報表查詢
--   - 資料分析
--   - 監控系統
--
-- 執行方式:
--   docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js

-- ============================================
-- Read-Only User
-- ============================================

-- 不存在才建立，已存在則跳過（不會重設密碼）
CREATE USER IF NOT EXISTS 'app_readonly'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次建立時強制改密碼

-- 只給 SELECT 權限 (請依需求修改資料庫名稱)
-- GRANT SELECT ON your_database.* TO 'app_readonly'@'%';

-- 如需存取多個資料庫，逐一加入:
-- GRANT SELECT ON database1.* TO 'app_readonly'@'%';
-- GRANT SELECT ON database2.* TO 'app_readonly'@'%';

-- 套用變更
FLUSH PRIVILEGES;
