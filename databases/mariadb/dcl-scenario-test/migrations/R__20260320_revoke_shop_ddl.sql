-- @allow-forbidden: true
-- R__20260320_revoke_shop_ddl.sql
-- DCL High-Risk: REVOKE — shop_ddl
-- ⚠️  Contains REVOKE statements — approved via @allow-forbidden
-- ⚠️  Uses CONTINUE HANDLER FOR 1141 for MariaDB 10.6 idempotency

-- ============================================
-- Revoke: shop_ddl (DROP, ALTER ON ecommerce.*)
-- ============================================

USE mysql; -- temp procedure context
DROP PROCEDURE IF EXISTS _ddl_revoke_tmp;
DELIMITER //
CREATE PROCEDURE _ddl_revoke_tmp()
BEGIN
  DECLARE CONTINUE HANDLER FOR 1141 BEGIN END;
  REVOKE DROP, ALTER ON ecommerce.* FROM 'shop_ddl'@'%';
END //
DELIMITER ;
CALL _ddl_revoke_tmp();
DROP PROCEDURE IF EXISTS _ddl_revoke_tmp;

-- Apply changes
FLUSH PRIVILEGES;
