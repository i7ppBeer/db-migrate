/**
 * MariaDB Production Server - DDL Configuration (ecommerce database)
 * 
 * DDL (Data Definition Language) migrations use Versioned mode:
 * - Files prefixed with timestamp: 20260101000001-xxx.sql
 * - Requires both UP and DOWN migrations
 * - Executed once, tracked in changelog
 * 
 * Managed by: Development Team (ecommerce)
 */

export default {
  type: 'mariadb',
  user: process.env.ECOMMERCE_DDL_USER || 'ecommerce_ddl_admin',
  password: process.env.ECOMMERCE_DDL_PASSWORD || 'ecommerce_ddl_secure_pass_111',
  database: 'ecommerce',
};
