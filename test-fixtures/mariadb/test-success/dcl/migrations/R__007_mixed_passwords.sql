-- Repeatable Migration: Mixed static and auto-generated passwords
-- @allow-dangerous: false
--
-- PURPOSE: Verify that only the account using CHANGE_ME_ON_FIRST_LOGIN gets a
--          credential event — static-password accounts must be ignored.

-- Static password account — should NOT produce a credential event
CREATE USER IF NOT EXISTS 'static_api'@'%' IDENTIFIED BY 'hardcoded_pass_123';
GRANT SELECT ON test_mariadb_success.* TO 'static_api'@'%';

-- Auto-generated password account — SHOULD produce a credential event
CREATE USER IF NOT EXISTS 'secret_api'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT, INSERT ON test_mariadb_success.* TO 'secret_api'@'%';

FLUSH PRIVILEGES;
