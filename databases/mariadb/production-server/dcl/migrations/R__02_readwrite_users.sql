-- R__02_readwrite_users.sql
-- DCL Repeatable Migration: Read-Write Users (Application Service Accounts)
--
-- This script is idempotent - safe to run multiple times
-- Will be re-executed when checksum changes

-- ============================================
-- Application User for ecommerce database
-- ============================================

DROP USER IF EXISTS 'ecommerce_app'@'%';
CREATE USER 'ecommerce_app'@'%' IDENTIFIED BY 'ecommerce_app_secure_pass_123';

-- Full CRUD permissions for application
GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce.* TO 'ecommerce_app'@'%';

-- ============================================
-- Application User for analytics database
-- ============================================

DROP USER IF EXISTS 'analytics_app'@'%';
CREATE USER 'analytics_app'@'%' IDENTIFIED BY 'analytics_app_secure_pass_456';

-- Analytics needs write access for ETL processes
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.* TO 'analytics_app'@'%';

-- ============================================
-- Application User for logging database
-- ============================================

DROP USER IF EXISTS 'logging_app'@'%';
CREATE USER 'logging_app'@'%' IDENTIFIED BY 'logging_app_secure_pass_789';

-- Logging primarily needs INSERT, but may need UPDATE for status changes
GRANT SELECT, INSERT, UPDATE ON logging.* TO 'logging_app'@'%';

-- Apply changes
FLUSH PRIVILEGES;
