-- Repeatable Migration: INVALID - Dangerous operations
-- This should FAIL security check

-- Dangerous: Creating superuser
CREATE USER IF NOT EXISTS 'super_admin'@'%' IDENTIFIED BY 'super_password';

-- Dangerous: Granting ALL including GRANT OPTION
GRANT ALL PRIVILEGES ON *.* TO 'super_admin'@'%' WITH GRANT OPTION;

FLUSH PRIVILEGES;
