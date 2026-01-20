/**
 * MariaDB/MySQL Test Sample Config - Success Cases
 */
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'test_mariadb_success',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'rootpass'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'
};
