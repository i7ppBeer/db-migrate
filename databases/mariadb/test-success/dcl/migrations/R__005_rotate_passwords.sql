-- Repeatable Migration: Force password rotation on existing service accounts
-- @allow-dangerous: false
--
-- PURPOSE: ALTER USER (not CREATE USER IF NOT EXISTS) so MariaDB does NOT emit
--          Note 1973 → SHOW WARNINGS stays empty → alreadyExists = false →
--          runner ALWAYS writes new credentials to /tmp/secret.
-- This models a "forced rotation" pattern: every time this file is bumped,
-- a fresh password lands in /tmp/secret.

ALTER USER 'readonly_svc'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
ALTER USER 'readwrite_svc'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
FLUSH PRIVILEGES;
