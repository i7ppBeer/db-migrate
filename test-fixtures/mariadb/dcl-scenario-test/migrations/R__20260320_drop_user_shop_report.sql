-- @allow-forbidden: true
-- R__20260320_drop_user_shop_report.sql
-- DCL High-Risk: DROP USER — shop_report
-- ⚠️  DROP USER is irreversible — approved via @allow-forbidden

-- ============================================
-- Drop: shop_report
-- ============================================

DROP USER IF EXISTS 'shop_report'@'%';

-- Apply changes
FLUSH PRIVILEGES;
