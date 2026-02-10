-- Repeatable Migration: Create application user
-- This migration is idempotent and will be re-run if checksum changes

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'app_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON test_mariadb_success.* TO 'app_user'@'%';
FLUSH PRIVILEGES;
