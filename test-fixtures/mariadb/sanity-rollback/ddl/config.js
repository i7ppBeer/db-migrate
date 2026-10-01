/**
 * MariaDB Sanity Check — real rollback fixture.
 * Its one migration's Post-Check fails by design; with --sanity-check,
 * test-all checks it was rolled back and the database is as it was before.
 */
export default {
  type: 'mariadb',
  // Local docker-compose test database (see docker-compose.yml) — the tool
  // itself has no default credentials.
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'rootpass',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  database: process.env.MARIADB_DB || 'test_mariadb_sanity_rollback',
  changelogTable: '_migrations',
};
