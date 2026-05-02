/**
 * MariaDB FK Dependency Test Config
 * Tests cross-file and single-file FK validation
 */
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'test_mariadb_fk',
  changelogTable: '_migrations',
};
