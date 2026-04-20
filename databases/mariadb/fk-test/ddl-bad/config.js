/**
 * Config for bad-FK scenario (should fail validate)
 */
export default {
  type: 'mariadb',
  database: 'test_mariadb_fk_bad',
  changelogTable: '_migrations',
};
