-- R__03_ddl_admin.sql
-- DCL Repeatable Migration: DDL Admin Users (Schema Management)
--
-- This script is idempotent - safe to run multiple times
-- Will be re-executed when checksum changes
--
-- These users are for CI/CD pipelines to run DDL migrations

-- ============================================
-- DDL Admin for ecommerce database
-- ============================================

DROP USER IF EXISTS 'ecommerce_ddl_admin'@'%';
CREATE USER 'ecommerce_ddl_admin'@'%' IDENTIFIED BY 'ecommerce_ddl_secure_pass_111';

-- DDL permissions: CREATE, ALTER, DROP tables, indexes, etc.
GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce.* TO 'ecommerce_ddl_admin'@'%';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON ecommerce.* TO 'ecommerce_ddl_admin'@'%';

-- ============================================
-- DDL Admin for analytics database
-- ============================================

DROP USER IF EXISTS 'analytics_ddl_admin'@'%';
CREATE USER 'analytics_ddl_admin'@'%' IDENTIFIED BY 'analytics_ddl_secure_pass_222';

GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.* TO 'analytics_ddl_admin'@'%';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON analytics.* TO 'analytics_ddl_admin'@'%';

-- ============================================
-- DDL Admin for logging database
-- ============================================

DROP USER IF EXISTS 'logging_ddl_admin'@'%';
CREATE USER 'logging_ddl_admin'@'%' IDENTIFIED BY 'logging_ddl_secure_pass_333';

GRANT SELECT, INSERT, UPDATE, DELETE ON logging.* TO 'logging_ddl_admin'@'%';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON logging.* TO 'logging_ddl_admin'@'%';

-- Apply changes
FLUSH PRIVILEGES;
