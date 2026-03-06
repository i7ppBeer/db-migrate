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
// loadConfig() will auto-merge src/config-defaults/mongodb-ddl.js
// Only specify values that differ from the defaults:
export default {
  type: 'mongodb',
  mongodb: { databaseName: 'your_database' }, // 請修改為實際資料庫名稱
};
