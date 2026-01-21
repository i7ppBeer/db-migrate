-- Repeatable Migration: Create application user
-- This migration is idempotent and will be re-run if checksum changes

-- Create user if not exists
CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'app_password';

-- Grant permissions (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON test_mariadb_success.* TO 'app_user'@'%';

-- Apply changes
FLUSH PRIVILEGES;
