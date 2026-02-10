/**
 * DCL (Data Control Language) Configuration Template
 * 帳號權限管理 - Repeatable 模式
 * 
 * 使用方式:
 *   1. cp -r databases/mariadb/_templates/dcl databases/mariadb/<project>/dcl
 *   2. 修改 config.js 和 migrations/*.sql
 *   3. docker compose run --rm migrate dcl -c /app/databases/mariadb/<project>/dcl/config.js
 */
export default {
  type: 'mariadb',
  
  // 資料庫連線設定 (使用環境變數，可在 docker-compose 中覆蓋)
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MARIADB_PASSWORD environment variable is required in production');
      }
      return 'rootpass'; // ⚠️ 僅限開發環境使用
    })(),
    // DCL 操作在 mysql 系統資料庫
    database: 'mysql'
  },
  
  // Migration 檔案目錄 (相對於此 config 檔案)
  migrationsDir: './migrations',
  
  // Checksum 追蹤資料表
  checksumTable: 'dcl_repeatable_migrations',
  
  // 冪等性檢查設定
  // ⚠️ 注意: mode 和 idempotencyCheck.enabled 僅作為文件標記，
  //    程式碼不會讀取這兩個欄位。DCL 模式由 CLI 指令 (dcl) 決定。
  //    idempotencyCheck 的實際行為由 verbose 欄位控制。
  idempotencyCheck: {
    verbose: true
  }
};
