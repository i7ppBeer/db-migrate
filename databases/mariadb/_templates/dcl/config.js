/**
 * DCL (Data Control Language) Configuration Template
 * 帳號權限管理 - Repeatable 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mariadb/_templates/dcl databases/mariadb/<project>/dcl
 *   2. 修改 config.js 和 migrations/*.sql
 *   3. docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js
 */
// loadConfig() will auto-merge src/config-defaults/mariadb-dcl.js
// Only specify values that differ from the defaults:
export default {
  type: 'mariadb',
  mode: 'repeatable',
  // user: process.env.MY_DCL_USER || 'my_dcl_admin',
  // password: process.env.MY_DCL_PASSWORD || 'my_dcl_pass',
};
