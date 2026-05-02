-- DCL: Create application read-write user
-- Repeatable migration - re-applied when checksum changes
-- Must be idempotent (safe to run multiple times)

-- Create user if not exists
CREATE USER IF NOT EXISTS 'app_readwrite'@'%' IDENTIFIED BY 'readwrite_pass';

-- Grant read-write access to all instances
GRANT SELECT, INSERT, UPDATE, DELETE ON test_multi_primary.* TO 'app_readwrite'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON test_multi_secondary.* TO 'app_readwrite'@'%';

FLUSH PRIVILEGES;
