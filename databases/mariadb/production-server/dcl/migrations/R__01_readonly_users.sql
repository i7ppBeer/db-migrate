-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users
-- 
-- This script is idempotent - uses CREATE USER IF NOT EXISTS
-- Will be re-executed when checksum changes

-- ============================================
-- Read-Only User for ecommerce database
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'ecommerce_readonly'@'%' IDENTIFIED BY 'readonly_secure_password_123';

-- Grant read-only permissions
GRANT SELECT ON ecommerce.* TO 'ecommerce_readonly'@'%';

-- ============================================
-- Read-Only User for analytics database  
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'analytics_readonly'@'%' IDENTIFIED BY 'analytics_readonly_pass_456';

GRANT SELECT ON analytics.* TO 'analytics_readonly'@'%';

-- ============================================
-- Read-Only User for logging database
-- ============================================

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'logging_readonly'@'%' IDENTIFIED BY 'logging_readonly_pass_789';

GRANT SELECT ON logging.* TO 'logging_readonly'@'%';

-- Apply changes
FLUSH PRIVILEGES;
