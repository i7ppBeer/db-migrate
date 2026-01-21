-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users
-- 
-- This script is idempotent - safe to run multiple times
-- Will be re-executed when checksum changes

-- ============================================
-- Read-Only User for ecommerce database
-- ============================================

-- Drop and recreate to ensure clean state (idempotent pattern)
DROP USER IF EXISTS 'ecommerce_readonly'@'%';
CREATE USER 'ecommerce_readonly'@'%' IDENTIFIED BY 'readonly_secure_password_123';

-- Grant read-only permissions
GRANT SELECT ON ecommerce.* TO 'ecommerce_readonly'@'%';

-- ============================================
-- Read-Only User for analytics database  
-- ============================================

DROP USER IF EXISTS 'analytics_readonly'@'%';
CREATE USER 'analytics_readonly'@'%' IDENTIFIED BY 'analytics_readonly_pass_456';

GRANT SELECT ON analytics.* TO 'analytics_readonly'@'%';

-- ============================================
-- Read-Only User for logging database
-- ============================================

DROP USER IF EXISTS 'logging_readonly'@'%';
CREATE USER 'logging_readonly'@'%' IDENTIFIED BY 'logging_readonly_pass_789';

GRANT SELECT ON logging.* TO 'logging_readonly'@'%';

-- Apply changes
FLUSH PRIVILEGES;
