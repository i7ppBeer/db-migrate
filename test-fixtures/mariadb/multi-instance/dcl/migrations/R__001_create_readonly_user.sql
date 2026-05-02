-- DCL: Create application read-only user
-- Repeatable migration - re-applied when checksum changes
-- Must be idempotent (safe to run multiple times)

-- Create user if not exists
CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'readonly_pass';

-- Grant read-only access to all instances
GRANT SELECT ON test_multi_primary.* TO 'app_readonly'@'%';
GRANT SELECT ON test_multi_secondary.* TO 'app_readonly'@'%';

FLUSH PRIVILEGES;
