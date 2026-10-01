/**
 * MariaDB DCL Test Config - Failure Cases
 * 
 * These migrations should be REJECTED by DDL sanity checker
 * because DCL operations don't belong in DDL migrations
 */
export default {
  type: 'mariadb',
  // Local docker-compose test database (see docker-compose.yml) — the tool
  // itself has no default credentials.
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'rootpass',
  mode: 'repeatable',
  database: process.env.MARIADB_DB || 'mysql',
  checksumTable: '_dcl_migrations',
};
