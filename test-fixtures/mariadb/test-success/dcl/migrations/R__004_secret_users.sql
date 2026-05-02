-- Repeatable Migration: Secret users (auto-generated passwords)
-- @allow-dangerous: false

-- These accounts use CHANGE_ME_ON_FIRST_LOGIN as a placeholder.
-- The runner will auto-generate a secure password and save it to /tmp/secret.
CREATE USER IF NOT EXISTS 'readonly_svc'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
CREATE USER IF NOT EXISTS 'readwrite_svc'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT ON test_mariadb_success.* TO 'readonly_svc'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON test_mariadb_success.* TO 'readwrite_svc'@'%';
FLUSH PRIVILEGES;
