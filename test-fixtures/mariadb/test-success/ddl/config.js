/**
 * MariaDB/MySQL Test Sample Config - Success Cases
 */
export default {
  type: 'mariadb',
  // Local docker-compose test database (see docker-compose.yml) — the tool
  // itself has no default credentials.
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'rootpass',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  database: process.env.MARIADB_DB || 'test_mariadb_success',
  changelogTable: '_migrations',
};
