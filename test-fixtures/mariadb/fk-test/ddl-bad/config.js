/**
 * Config for bad-FK scenario (should fail validate)
 */
export default {
  type: 'mariadb',
  database: 'test_mariadb_fk_bad',
  changelogTable: '_migrations',
  // test-all only: this fixture's migrations are intentionally malformed —
  // validate and up-down-up are expected to fail, and that counts as a pass.
  expectFailure: true,
};
