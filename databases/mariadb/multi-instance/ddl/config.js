/**
 * MariaDB Multi-Instance DDL Config
 * 
 * 結構變更管理 - 對多個 database instance 執行相同的 versioned migrations
 * 
 * 使用方式:
 *   docker compose run --rm migrate up-all -c /app/databases/mariadb/multi-instance/ddl/config.js
 *   docker compose run --rm migrate status-all -c /app/databases/mariadb/multi-instance/ddl/config.js
 */
export default {
  type: 'mariadb',
  changelogTable: '_migrations',

  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'test_multi_primary',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass',
      },
    },
    {
      name: 'secondary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'test_multi_secondary',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass',
      },
    },
  ],
};
