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
  
  // 所有 instance 共用的 DCL migrations
  migrationsDir: './migrations',
  checksumCollection: '_dcl_migrations',
  mode: 'repeatable',
  
  // 冪等性檢查設定
  idempotencyCheck: {
    enabled: true,
    verbose: true
  },
  
  // 多個 database instances
  instances: [
    {
      name: 'primary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'admin'
      }
    },
    {
      name: 'secondary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'admin'
      }
    }
  ]
};
