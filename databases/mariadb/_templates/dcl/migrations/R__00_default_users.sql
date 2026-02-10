-- R__00_default_users.sql
-- DCL Repeatable Migration: Default Service Account (公版範本)
-- 
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 CREATE USER IF NOT EXISTS 模式，不影響已存在的帳號
--
-- 說明:
--   - 此帳號為基本服務帳號範本
--   - 第一次建立時需自行修改密碼 (PASSWORD EXPIRE)
--   - 已存在的帳號不會被重建，只會更新權限
--   - 請依實際需求修改資料庫名稱和權限
--
-- 執行方式:
--   docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js

-- ============================================
-- Default Service Account
-- ============================================

-- 不存在才建立，已存在則跳過（不會重設密碼）
CREATE USER IF NOT EXISTS 'app_default'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次建立時強制改密碼

-- 基本權限 (請依需求修改)
-- GRANT SELECT ON your_database.* TO 'app_default'@'%';

-- 套用變更
FLUSH PRIVILEGES;
