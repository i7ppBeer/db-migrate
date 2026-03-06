/**
 * MongoDB DCL (Data Control Language) Configuration Template
 * 帳號權限管理 - Repeatable 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mongodb/_templates/dcl databases/mongodb/<project>/dcl
 *   2. 修改 config.js 和 migrations/*.js
 *   3. docker compose run --rm migrate dcl -c /app/databases/mongodb/<project>/dcl/config.js
 */
// loadConfig() will auto-merge src/config-defaults/mongodb-dcl.js
// Only specify values that differ from the defaults:
export default {
  type: 'mongodb',
  mode: 'repeatable',
  // mongodb: { databaseName: 'admin' },
};
