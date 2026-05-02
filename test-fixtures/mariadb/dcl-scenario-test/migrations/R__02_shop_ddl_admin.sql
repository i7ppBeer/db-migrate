-- R__02_shop_ddl_admin.sql
-- DCL Repeatable Migration: Shop DDL Admin
--
-- Idempotent: CREATE USER IF NOT EXISTS
-- Re-executed when checksum changes

-- ============================================
-- shop_ddl
-- ============================================

CREATE USER IF NOT EXISTS 'shop_ddl'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX ON ecommerce.* TO 'shop_ddl'@'%';

ALTER USER 'shop_ddl'@'%' WITH MAX_USER_CONNECTIONS 3;

-- Apply changes
FLUSH PRIVILEGES;
