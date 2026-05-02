/**
 * MariaDB Multi-Instance DCL Config
 * 
 * 帳號權限管理 - 對多個 database instance 執行相同的 repeatable migrations
 * 
 * 使用方式:
 *   docker compose run --rm migrate dcl-all -c /app/databases/mariadb/multi-instance/dcl/config.js
 *   docker compose run --rm migrate dcl:status-all -c /app/databases/mariadb/multi-instance/dcl/config.js
 *   docker compose run --rm migrate dcl:verify-all -c /app/databases/mariadb/multi-instance/dcl/config.js
 */
export default {
  type: 'mariadb',
  mode: 'repeatable',
  checksumTable: '_dcl_migrations',

  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'mysql',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass',
      },
    },
    {
      name: 'secondary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'mysql',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass',
      },
    },
  ],
};
