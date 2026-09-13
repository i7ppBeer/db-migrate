/**
 * MariaDB Lock Guard E2E fixture
 * Used by test/integration.test.js to reproduce the MDL-queue-jam incident
 * (large uncommitted DELETE + concurrent ALTER TABLE) against a real server,
 * and prove the executeWithLockGuard() fix fails fast / recovers instead of
 * hanging and dragging downstream SELECTs down with it.
 */
export default {
  type: 'mariadb',
  database: process.env.MARIADB_LOCK_GUARD_DB || 'lock_guard_e2e_test',
  changelogTable: '_migrations',
};
