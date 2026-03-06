/**
 * MariaDB/MySQL Test Sample Config - Success Cases
 */
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'test_mariadb_success',
  changelogTable: '_migrations',
};
