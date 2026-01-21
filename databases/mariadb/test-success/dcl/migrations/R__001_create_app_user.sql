-- Repeatable Migration: Create application user
-- This migration is idempotent and will be re-run if checksum changes

-- Drop and recreate to ensure clean state (idempotent pattern)
DROP USER IF EXISTS 'app_user'@'%';
CREATE USER 'app_user'@'%' IDENTIFIED BY 'app_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON test_mariadb_success.* TO 'app_user'@'%';
FLUSH PRIVILEGES;
