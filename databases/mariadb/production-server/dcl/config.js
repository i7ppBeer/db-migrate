/**
 * MariaDB Production Server - DCL Configuration
 * 
 * DCL (Data Control Language) migrations use Repeatable mode:
 * - Files prefixed with R__ are re-executed when checksum changes
 * - Must be idempotent (same result on multiple executions)
 * - No down migration required
 * 
 * Managed by: Platform Team
 */

export default {
  type: 'mariadb',
  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306'),
  user: process.env.MARIADB_USER || 'root',
  password: process.env.MARIADB_PASSWORD || 'rootpass',
  database: 'mysql', // DCL operates on mysql system database
  
  // DCL migrations directory (Repeatable mode)
  migrationsDir: './migrations',
  
  // Checksum table for tracking repeatable migrations
  checksumTable: 'dcl_repeatable_migrations',
  
  // Migration mode: 'repeatable' for DCL
  mode: 'repeatable',
  
  // Idempotency verification enabled
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
