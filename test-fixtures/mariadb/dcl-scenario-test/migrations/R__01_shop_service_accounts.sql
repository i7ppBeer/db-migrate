-- R__01_shop_service_accounts.sql
-- DCL Repeatable Migration: Shop Service Accounts
--
-- Idempotent: CREATE USER IF NOT EXISTS
-- Re-executed when checksum changes

-- ============================================
-- shop_api
-- ============================================

CREATE USER IF NOT EXISTS 'shop_api'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT, INSERT, UPDATE, DELETE ON ecommerce.* TO 'shop_api'@'%';

ALTER USER 'shop_api'@'%' WITH MAX_QUERIES_PER_HOUR 2000 MAX_USER_CONNECTIONS 10;

-- ============================================
-- shop_report
-- ============================================

CREATE USER IF NOT EXISTS 'shop_report'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT ON ecommerce.orders TO 'shop_report'@'%';
GRANT SELECT ON analytics.events TO 'shop_report'@'%';

-- Apply changes
FLUSH PRIVILEGES;
