/**
 * MariaDB Lock Guard E2E fixture
 * Used by test/integration.test.js to reproduce the MDL-queue-jam incident
 * (large uncommitted DELETE + concurrent ALTER TABLE) against a real server,
 * and prove the executeWithLockGuard() fix fails fast / recovers instead of
 * hanging and dragging downstream SELECTs down with it.
 */
export default {
  type: 'mariadb',
  // Local docker-compose test database (see docker-compose.yml) — the tool
  // itself has no default credentials.
  user: process.env.MARIADB_USER ?? 'root',
  password: process.env.MARIADB_PASSWORD ?? 'rootpass',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  database: process.env.MARIADB_LOCK_GUARD_DB || 'lock_guard_e2e_test',
  changelogTable: '_migrations',
};
