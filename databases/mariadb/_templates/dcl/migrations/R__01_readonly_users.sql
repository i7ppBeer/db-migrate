-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users (公版範本)
--
-- ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
-- ⚠️ 使用 DROP USER IF EXISTS + CREATE USER 模式確保冪等性
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

DROP USER IF EXISTS 'app_readonly'@'%';
CREATE USER 'app_readonly'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次登入強制改密碼

-- 只給 SELECT 權限 (請依需求修改資料庫名稱)
-- GRANT SELECT ON your_database.* TO 'app_readonly'@'%';

-- 如需存取多個資料庫，逐一加入:
-- GRANT SELECT ON database1.* TO 'app_readonly'@'%';
-- GRANT SELECT ON database2.* TO 'app_readonly'@'%';

-- 套用變更
FLUSH PRIVILEGES;
