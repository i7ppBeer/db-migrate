-- @allow-forbidden: true
-- R__20260320_drop_user_shop_ddl.sql
-- DCL High-Risk: DROP USER — shop_ddl
-- ⚠️  DROP USER is irreversible — approved via @allow-forbidden

-- ============================================
-- Drop: shop_ddl
-- ============================================

DROP USER IF EXISTS 'shop_ddl'@'%';

-- Apply changes
FLUSH PRIVILEGES;
