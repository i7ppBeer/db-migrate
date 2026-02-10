-- R__02_readwrite_users.sql
-- DCL Repeatable Migration: Read-Write Users (Application Service Accounts)
--
-- This script is idempotent - uses CREATE USER IF NOT EXISTS
-- Will be re-executed when checksum changes

-- ============================================
-- Application User for ecommerce database
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'ecommerce_app'@'%' IDENTIFIED BY 'ecommerce_app_secure_pass_123';

-- Full CRUD permissions for application
GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce.* TO 'ecommerce_app'@'%';

-- ============================================
-- Application User for analytics database
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'analytics_app'@'%' IDENTIFIED BY 'analytics_app_secure_pass_456';

-- Analytics needs write access for ETL processes
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.* TO 'analytics_app'@'%';

-- ============================================
-- Application User for logging database
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'logging_app'@'%' IDENTIFIED BY 'logging_app_secure_pass_789';

-- Logging primarily needs INSERT, but may need UPDATE for status changes
GRANT SELECT, INSERT, UPDATE ON logging.* TO 'logging_app'@'%';

-- Apply changes
FLUSH PRIVILEGES;
