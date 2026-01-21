/**
 * MongoDB DDL (Data Definition Language) Configuration Template
 * 結構變更管理 - Versioned 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mongodb/_templates/ddl databases/mongodb/<project>/ddl
 *   2. 修改 config.js
 *   3. docker compose run --rm migrate up -c /app/databases/mongodb/<project>/ddl/config.js
 *   4. docker compose run --rm migrate down -n 1 -c /app/databases/mongodb/<project>/ddl/config.js
 *   5. docker compose run --rm migrate validate -c /app/databases/mongodb/<project>/ddl/config.js
 */
export default {
  type: 'mongodb',
  
  // MongoDB 連線設定
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'your_database',  // 請修改為實際資料庫名稱
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  
  // Migration 檔案目錄 (相對於此 config 檔案)
  migrationsDir: './migrations',
  
  // Migration 記錄 Collection
  changelogCollection: '_migrations'
};
