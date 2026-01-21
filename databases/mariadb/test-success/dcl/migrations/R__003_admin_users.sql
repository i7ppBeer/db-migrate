-- DCL Repeatable Migration: admin_users
-- File: R__003_admin_users.sql
-- Created: 2026-01-21T08:55:13.275Z
--
-- ⚠️  IMPORTANT: This script must be IDEMPOTENT!
-- It will run whenever the checksum changes.
-- Always use IF NOT EXISTS / IF EXISTS patterns!
-- ============================================

-- Example: Create user (idempotent)
-- CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'password';

-- Example: Grant permissions (idempotent by nature)
-- GRANT SELECT ON mydb.* TO 'app_readonly'@'%';

-- Example: Revoke then Grant for exact permissions
-- REVOKE ALL PRIVILEGES ON mydb.* FROM 'app_user'@'%';
-- GRANT SELECT, INSERT, UPDATE ON mydb.* TO 'app_user'@'%';

-- Apply changes
-- FLUSH PRIVILEGES;

-- Your DCL statements here:

