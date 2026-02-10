-- Repeatable Migration: Create readonly user
-- This migration is idempotent and will be re-run if checksum changes

-- Create only if not exists (won't reset existing password)
CREATE USER IF NOT EXISTS 'readonly_user'@'%' IDENTIFIED BY 'readonly_password';
GRANT SELECT ON test_mariadb_success.* TO 'readonly_user'@'%';
FLUSH PRIVILEGES;
