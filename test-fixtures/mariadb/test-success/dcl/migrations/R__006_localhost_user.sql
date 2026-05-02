-- Repeatable Migration: Localhost-restricted service account
-- @allow-dangerous: false
--
-- PURPOSE: Verify that the username extractor correctly handles a non-'%' hostname.
-- The regex must match 'local_svc'@'localhost', not just 'local_svc'@'%'.

CREATE USER IF NOT EXISTS 'local_svc'@'localhost' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON test_mariadb_success.* TO 'local_svc'@'localhost';
FLUSH PRIVILEGES;
