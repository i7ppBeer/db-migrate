-- R__02_readwrite_users.sql
-- DCL Repeatable Migration: Read-Write Users (公版範本)
--
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 CREATE USER IF NOT EXISTS 模式，不影響已存在的帳號
--
-- 用途:
--   - 應用程式服務帳號
--   - CRUD 操作
--   - API 服務
--
-- 執行方式:
--   docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js

-- ============================================
-- Application Read-Write User
-- ============================================

-- 不存在才建立，已存在則跳過（不會重設密碼）
CREATE USER IF NOT EXISTS 'app_readwrite'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次建立時強制改密碼

-- SELECT, INSERT, UPDATE, DELETE 權限 (請依需求修改資料庫名稱)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON your_database.* TO 'app_readwrite'@'%';

-- 如需執行 Stored Procedure:
-- GRANT EXECUTE ON your_database.* TO 'app_readwrite'@'%';

-- 套用變更
FLUSH PRIVILEGES;
