/**
 * MariaDB DCL Test Config - Success Cases
 * 
 * DCL (Data Control Language) uses Repeatable mode:
 * - Files prefixed with R__ are re-executed when checksum changes
 * - Must be idempotent
 */
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: process.env.MARIADB_DB || 'mysql',
  checksumTable: '_dcl_migrations',
};
