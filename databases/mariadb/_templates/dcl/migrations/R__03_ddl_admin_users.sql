-- R__03_ddl_admin_users.sql
-- DCL Repeatable Migration: DDL Admin Users (公版範本)
--
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 CREATE USER IF NOT EXISTS 模式，不影響已存在的帳號
--
-- 用途:
--   - Schema 管理員
--   - Migration 執行者
--   - DevOps 部署帳號
--
-- 執行方式:
--   docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js

-- ============================================
-- DDL Admin User (Schema 管理)
-- ============================================

-- 不存在才建立，已存在則跳過（不會重設密碼）
CREATE USER IF NOT EXISTS 'app_ddl_admin'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次建立時強制改密碼

-- CRUD + DDL 權限 (請依需求修改資料庫名稱)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON your_database.* TO 'app_ddl_admin'@'%';
-- GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON your_database.* TO 'app_ddl_admin'@'%';

-- 如需 VIEW 權限:
-- GRANT CREATE VIEW, SHOW VIEW ON your_database.* TO 'app_ddl_admin'@'%';

-- 如需 Trigger 權限:
-- GRANT TRIGGER ON your_database.* TO 'app_ddl_admin'@'%';

-- 套用變更
FLUSH PRIVILEGES;
