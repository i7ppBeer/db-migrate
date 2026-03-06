/**
 * MongoDB Multi-Instance DCL Config
 * 
 * 帳號權限管理 - 對多個 database instance 執行相同的 repeatable migrations
 * 
 * 使用方式:
 *   docker compose run --rm migrate dcl-all -c /app/databases/mongodb/multi-instance/dcl/config.js
 *   docker compose run --rm migrate dcl:status-all -c /app/databases/mongodb/multi-instance/dcl/config.js
 *   docker compose run --rm migrate dcl:verify-all -c /app/databases/mongodb/multi-instance/dcl/config.js
 */
export default {
  type: 'mongodb',
  mode: 'repeatable',
  checksumCollection: '_dcl_migrations',

  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mongodb: {
        url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
        databaseName: 'admin',
      },
    },
    {
      name: 'secondary-db',
      mongodb: {
        url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
        databaseName: 'admin',
      },
    },
  ],
};
