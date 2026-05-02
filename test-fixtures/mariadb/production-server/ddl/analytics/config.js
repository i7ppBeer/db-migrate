/**
 * MariaDB Production Server - DDL Configuration (analytics database)
 * 
 * DDL (Data Definition Language) migrations use Versioned mode:
 * - Files prefixed with timestamp: 20260101000001-xxx.sql
 * - Requires both UP and DOWN migrations
 * - Executed once, tracked in changelog
 * 
 * Managed by: Data Team (analytics)
 * 
 * 使用方式:
 *   docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/analytics/config.js
 *   docker compose run --rm migrate status -c /app/databases/mariadb/production-server/ddl/analytics/config.js
 */

export default {
  type: 'mariadb',
  user: process.env.ANALYTICS_DDL_USER || 'analytics_ddl_admin',
  password: process.env.ANALYTICS_DDL_PASSWORD || 'analytics_ddl_secure_pass_222',
  database: 'analytics',
};
