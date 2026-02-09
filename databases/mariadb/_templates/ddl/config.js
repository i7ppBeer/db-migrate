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
export default {
  type: 'mariadb',
  
  // 資料庫連線設定
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'your_database',  // 請修改為實際資料庫名稱
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || (() => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('MARIADB_PASSWORD environment variable is required in production');
      }
      return 'rootpass'; // ⚠️ 僅限開發環境使用
    })()
  },
  
  // Migration 檔案目錄 (相對於此 config 檔案)
  migrationsDir: './migrations',
  
  // Migration 記錄資料表
  changelogTable: '_migrations',
  
  // Sanity Check 設定 (建議啟用)
  sanityCheck: {
    enabled: true,        // 啟用 PreCheck/PostCheck
    autoRollback: true,   // PostCheck 失敗時自動 rollback
    verbose: true         // 顯示詳細資訊
  }
};
