/**
 * MariaDB/MySQL Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mariadb',
  // Local docker-compose test database (see docker-compose.yml) — the tool
  // itself has no default credentials.
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'rootpass',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  database: process.env.MARIADB_DB || 'test_mariadb_failure',
  changelogTable: '_migrations',
  // Each migration here declares how it must be rejected (-- @expect-error: CODE)
  // — test-all checks exactly that, per file. See src/core/fixture-expectations.js.
};
