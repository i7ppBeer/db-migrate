/**
 * MongoDB Multi-Instance DDL Config
 * 
 * 結構變更管理 - 對多個 database instance 執行相同的 versioned migrations
 * 
 * 使用方式:
 *   docker compose run --rm migrate up-all -c /app/databases/mongodb/multi-instance/ddl/config.js
 *   docker compose run --rm migrate status-all -c /app/databases/mongodb/multi-instance/ddl/config.js
 */
export default {
  type: 'mongodb',
  changelogCollection: '_migrations',

  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mongodb: {
        url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
        databaseName: 'test_multi_primary',
      },
    },
    {
      name: 'secondary-db',
      mongodb: {
        url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
        databaseName: 'test_multi_secondary',
      },
    },
  ],
};
