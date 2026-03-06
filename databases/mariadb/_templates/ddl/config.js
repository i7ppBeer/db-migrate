/**
 * DDL (Data Definition Language) Configuration Template
 * 結構變更管理 - Versioned 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mariadb/_templates/ddl databases/mariadb/<project>/ddl
 *   2. 修改 config.js
 *   3. docker compose run --rm migrate up -c /app/databases/mariadb/<project>/ddl/config.js
 *   4. docker compose run --rm migrate down -n 1 -c /app/databases/mariadb/<project>/ddl/config.js
 *   5. docker compose run --rm migrate validate -c /app/databases/mariadb/<project>/ddl/config.js
 */
// loadConfig() will auto-merge src/config-defaults/mariadb-ddl.js
// Only specify values that differ from the defaults:
export default {
  type: 'mariadb',
  database: 'your_database', // 請修改為實際資料庫名稱
  // user: process.env.MY_DDL_USER || 'my_ddl_admin',
  // password: process.env.MY_DDL_PASSWORD || 'my_ddl_pass',
};
