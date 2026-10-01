/**
 * MariaDB DCL Test Config - Success Cases
 * 
 * DCL (Data Control Language) uses Repeatable mode:
 * - Files prefixed with R__ are re-executed when checksum changes
 * - Must be idempotent
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
