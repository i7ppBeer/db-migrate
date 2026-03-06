/**
 * MariaDB DCL Test Config - Failure Cases
 * 
 * These migrations should be REJECTED by DDL sanity checker
 * because DCL operations don't belong in DDL migrations
 */
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: process.env.MARIADB_DB || 'mysql',
  checksumTable: '_dcl_migrations',
};
