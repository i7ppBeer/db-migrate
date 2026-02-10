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
  
  // 所有 instance 共用的 migrations
  migrationsDir: './migrations',
  changelogCollection: '_migrations',
  
  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'test_multi_primary'
      }
    },
    {
      name: 'secondary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'test_multi_secondary'
      }
    }
  ]
};
