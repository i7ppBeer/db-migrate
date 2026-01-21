/**
 * MariaDB DCL Test Config - Failure Cases
 * 
 * These migrations should be REJECTED by DDL sanity checker
 * because DCL operations don't belong in DDL migrations
 */
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'mysql',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'rootpass'
  },
  migrationsDir: './migrations',
  checksumTable: '_dcl_migrations',
  mode: 'repeatable',
  idempotencyCheck: {
    enabled: true
  }
};
