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
  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306'),
  user: process.env.ECOMMERCE_DDL_USER || 'ecommerce_ddl_admin',
  password: process.env.ECOMMERCE_DDL_PASSWORD || 'ecommerce_ddl_secure_pass_111',
  database: 'ecommerce',
  
  // DDL migrations directory (Versioned mode)
  migrationsDir: './migrations',
  
  // Changelog table for tracking versioned migrations
  changelogTable: 'schema_migrations',
  
  // Migration mode: 'versioned' for DDL (default)
  mode: 'versioned',
  
  // Sanity check configuration
  sanityCheck: {
    enabled: true,
    autoRollback: true,
    timeoutMs: 30000,
    verbose: true
  }
};
