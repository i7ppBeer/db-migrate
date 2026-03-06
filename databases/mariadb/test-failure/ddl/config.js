/**
 * MariaDB/MySQL Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'test_mariadb_failure',
  changelogTable: '_migrations',
};
