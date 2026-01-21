/**
 * MongoDB DCL (Data Control Language) Configuration Template
 * 帳號權限管理 - Repeatable 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mongodb/_templates/dcl databases/mongodb/<project>/dcl
 *   2. 修改 config.js 和 migrations/*.js
 *   3. docker compose run --rm migrate dcl -c /app/databases/mongodb/<project>/dcl/config.js
 */
export default {
  type: 'mongodb',
  
  // MongoDB 連線設定 (使用環境變數，可在 docker-compose 中覆蓋)
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'admin',  // DCL 操作在 admin 資料庫
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  
  // Migration 檔案目錄 (相對於此 config 檔案)
  migrationsDir: './migrations',
  
  // Checksum 追蹤 Collection
  checksumCollection: '_dcl_migrations',
  
  // 使用 Repeatable 模式
  mode: 'repeatable',
  
  // 冪等性檢查設定
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
