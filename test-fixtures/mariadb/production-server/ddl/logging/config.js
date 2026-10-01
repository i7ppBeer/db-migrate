/**
 * MariaDB Production Server - DDL Configuration (logging database)
 * 
 * DDL (Data Definition Language) migrations use Versioned mode:
 * - Files prefixed with timestamp: 20260101000001-xxx.sql
 * - Requires both UP and DOWN migrations
 * - Executed once, tracked in changelog
 * 
 * Managed by: Platform Team (logging)
 * 
 * 使用方式:
 *   docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/logging/config.js
 *   docker compose run --rm migrate status -c /app/databases/mariadb/production-server/ddl/logging/config.js
 */

export default {
  type: 'mariadb',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  user: process.env.LOGGING_DDL_USER || 'logging_ddl_admin',
  password: process.env.LOGGING_DDL_PASSWORD || 'logging_ddl_secure_pass_333',
  database: 'logging',
};
