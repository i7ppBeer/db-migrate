-- R__00_default_users.sql
-- DCL Repeatable Migration: Default Service Account (公版範本)
-- 
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 DROP USER IF EXISTS + CREATE USER 模式確保冪等性
--
-- 說明:
--   - 此帳號為基本服務帳號範本
--   - 第一次登入需自行修改密碼 (PASSWORD EXPIRE)
--   - 請依實際需求修改資料庫名稱和權限
--
-- 執行方式:
--   docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js

-- ============================================
-- Default Service Account
-- ============================================

-- 先刪除再建立，確保冪等性
DROP USER IF EXISTS 'app_default'@'%';
CREATE USER 'app_default'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次登入強制改密碼

-- 基本權限 (請依需求修改)
-- GRANT SELECT ON your_database.* TO 'app_default'@'%';

-- 套用變更
FLUSH PRIVILEGES;
