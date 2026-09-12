/**
 * MariaDB/MySQL Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'test_mariadb_failure',
  changelogTable: '_migrations',
  // test-all only: this fixture's migrations are intentionally dangerous/broken —
  // validate and up-down-up are expected to fail, and that counts as a pass.
  expectFailure: true,
};
