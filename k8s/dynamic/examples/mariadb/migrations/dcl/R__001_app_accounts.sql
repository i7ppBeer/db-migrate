-- Repeatable: re-runs whenever this file changes, so it must be idempotent.
-- CHANGE_ME_ON_FIRST_LOGIN is replaced with a generated password, delivered
-- only in the run's DCL notification email (docs/DCL-PASSWORD.md).
CREATE USER IF NOT EXISTS 'shop_app'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
CREATE USER IF NOT EXISTS 'shop_readonly'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT, INSERT, UPDATE, DELETE ON shop.* TO 'shop_app'@'%';
GRANT SELECT ON shop.* TO 'shop_readonly'@'%';
