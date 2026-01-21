-- Repeatable Migration: Create readonly user
-- This migration is idempotent and will be re-run if checksum changes

-- Drop and recreate to ensure clean state (idempotent pattern)
DROP USER IF EXISTS 'readonly_user'@'%';
CREATE USER 'readonly_user'@'%' IDENTIFIED BY 'readonly_password';
GRANT SELECT ON test_mariadb_success.* TO 'readonly_user'@'%';
FLUSH PRIVILEGES;
