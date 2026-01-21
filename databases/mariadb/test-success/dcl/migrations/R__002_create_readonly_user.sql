-- Repeatable Migration: Create readonly user
-- This migration is idempotent and will be re-run if checksum changes

-- Create user if not exists
CREATE USER IF NOT EXISTS 'readonly_user'@'%' IDENTIFIED BY 'readonly_password';

-- Grant read-only permissions (idempotent)
GRANT SELECT ON test_mariadb_success.* TO 'readonly_user'@'%';

-- Apply changes
FLUSH PRIVILEGES;
