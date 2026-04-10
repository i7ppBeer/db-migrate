/**
 * MariaDB/MySQL Adapter
 * Implements SQL migrations using sql-migrate pattern
 */

import { BaseAdapter } from '../core/base-adapter.js';
import { SanityChecker, SQLChecks } from '../core/sanity-checker.js';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import nodeSqlParserPkg from 'node-sql-parser';
const { Parser: SQLParser } = nodeSqlParserPkg;

export class MariaDBAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.dbType = 'mariadb';
    this.connection = null;
    this.changelogTable = config.changelogTable || 'schema_migrations';
    this.sanityChecker = new SanityChecker({
      enabled: config.sanityCheck?.enabled ?? false,
      autoRollback: config.sanityCheck?.autoRollback ?? true,
      timeoutMs: config.sanityCheck?.timeoutMs ?? 30000,
      verbose: config.sanityCheck?.verbose ?? true
    });
  }

  /**
   * Get sanity check helpers for SQL
   */
  getSanityCheckHelpers() {
    return SQLChecks;
  }

  /**
   * Get MariaDB/SQL-specific validation rules
   * 
   * 分類說明：
   * - forbidden: 🔴 絕對禁止 (可用 --allow-forbidden 強制放行，需團隊審批)
   * - dangerous: 🟠 危險操作 (可用 --allow-dangerous 放行)
   * - warnings:  🟡 警告提示 (不阻擋執行)
   */
  getValidationRules(mode = 'versioned') {
    const isRepeatable = mode === 'repeatable';
    return {
      // ========================================
      // 🔴 絕對禁止 - 預設無法放行 (需 --allow-forbidden)
      // ========================================
      forbidden: {
        database: [
          { pattern: /DROP\s+DATABASE/i, code: 'DROP_DATABASE', message: '🔴 DATA LOSS: Drop database is forbidden / 禁止刪除資料庫' },
          { pattern: /DROP\s+SCHEMA/i, code: 'DROP_SCHEMA', message: '🔴 DATA LOSS: Drop schema is forbidden / 禁止刪除 SCHEMA' }
        ],
        // DCL mode: forbid DDL schema changes (must live in DDL versioned project)
        // DDL mode: forbid user/permission management (must live in DCL repeatable project)
        ...(isRepeatable ? {
          // DDL structural operations — absolutely not allowed in DCL (no bypass)
          dclReverse: [
            { pattern: /\bCREATE\s+TABLE\b/i,              code: 'CREATE_TABLE_IN_DCL',     message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bALTER\s+TABLE\b/i,               code: 'ALTER_TABLE_IN_DCL',      message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bDROP\s+TABLE\b/i,                code: 'DROP_TABLE_IN_DCL',       message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i, code: 'CREATE_INDEX_IN_DCL',   message: '🔴 DDL: Index management should be in DDL project (Versioned) / 索引管理應在 DDL 專案' },
            { pattern: /\bDROP\s+INDEX\b/i,                code: 'DROP_INDEX_IN_DCL',       message: '🔴 DDL: Index management should be in DDL project (Versioned) / 索引管理應在 DDL 專案' },
            { pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, code: 'CREATE_VIEW_IN_DCL', message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bALTER\s+VIEW\b/i,                code: 'ALTER_VIEW_IN_DCL',       message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bDROP\s+VIEW\b/i,                 code: 'DROP_VIEW_IN_DCL',        message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\bCREATE\s+(?:DEFINER\s*=\S+\s+)?(?:PROCEDURE|FUNCTION)\b/i, code: 'CREATE_ROUTINE_IN_DCL', message: '🔴 DDL: Routine management should be in DDL project (Versioned) / 程序管理應在 DDL 專案' },
            { pattern: /\bDROP\s+(?:PROCEDURE|FUNCTION)\b/i, code: 'DROP_ROUTINE_IN_DCL',  message: '🔴 DDL: Routine management should be in DDL project (Versioned) / 程序管理應在 DDL 專案' },
            { pattern: /\bCREATE\s+(?:DEFINER\s*=\S+\s+)?TRIGGER\b/i, code: 'CREATE_TRIGGER_IN_DCL', message: '🔴 DDL: Trigger management should be in DDL project (Versioned) / 觸發器管理應在 DDL 專案' },
            { pattern: /\bDROP\s+TRIGGER\b/i,              code: 'DROP_TRIGGER_IN_DCL',     message: '🔴 DDL: Trigger management should be in DDL project (Versioned) / 觸發器管理應在 DDL 專案' },
            { pattern: /\bRENAME\s+TABLE\b/i,              code: 'RENAME_TABLE_IN_DCL',     message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' }
          ],
          // High-risk DCL ops: irreversible or credential-sensitive — require -- @allow-forbidden: true
          dclHighRisk: [
            { pattern: /\bDROP\s+USER\b/i,                 code: 'DROP_USER',               message: '🔴 DCL HIGH RISK: DROP USER is irreversible, requires -- @allow-forbidden: true / DROP USER 為不可逆操作，需加 annotation 審批' },
            { pattern: /\bALTER\s+USER\b/i,                code: 'ALTER_USER',              message: '🔴 DCL HIGH RISK: ALTER USER (e.g. password change) requires -- @allow-forbidden: true / ALTER USER 含密碼變更，需加 annotation 審批' },
            { pattern: /\bSET\s+PASSWORD\s+FOR\b/i,        code: 'SET_PASSWORD',            message: '🔴 DCL HIGH RISK: Password change requires -- @allow-forbidden: true / 密碼變更需加 annotation 審批' },
            { pattern: /\bREVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE|REFERENCES|TRIGGER|EVENT|PROCESS|RELOAD|SUPER|REPLICATION|SHOW)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, code: 'REVOKE', message: '🔴 DCL HIGH RISK: REVOKE may remove critical permissions, requires -- @allow-forbidden: true / REVOKE 可能移除關鍵權限，需加 annotation 審批' }
          ]
        } : {
          dcl: [
          { pattern: /\bCREATE\s+USER\s+['"`@]/i, code: 'CREATE_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\bDROP\s+USER\s+(?:IF\s+EXISTS\s+)?['"`@]/i, code: 'DROP_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\bALTER\s+USER\s+['"`@]/i, code: 'ALTER_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\bSET\s+PASSWORD\s+FOR/i, code: 'SET_PASSWORD', message: '🔴 DCL: Password management should be in DCL project (Repeatable) / 密碼管理應在 DCL 專案' },
          { pattern: /\bGRANT\s+(?:ALL|USAGE|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE|REFERENCES|TRIGGER|EVENT|PROCESS|RELOAD|SUPER|REPLICATION|SHOW)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, code: 'GRANT', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /\bREVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE|REFERENCES|TRIGGER|EVENT|PROCESS|RELOAD|SUPER|REPLICATION|SHOW)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, code: 'REVOKE', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /\bFLUSH\s+PRIVILEGES/i, code: 'FLUSH_PRIVILEGES', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' }
          ]
        }),
        dataExfiltration: [
          { pattern: /\bSELECT\s+.*\s+INTO\s+OUTFILE/i, code: 'INTO_OUTFILE', message: '🔴 DATA RISK: Export data to file is forbidden / 禁止匯出資料到檔案' },
          { pattern: /\bLOAD\s+DATA\s+(?:LOCAL\s+)?INFILE/i, code: 'LOAD_DATA', message: '🔴 DATA RISK: Load data from file is forbidden / 禁止從檔案載入資料' },
          { pattern: /\bINTO\s+DUMPFILE/i, code: 'INTO_DUMPFILE', message: '🔴 DATA RISK: Export data is forbidden / 禁止匯出資料' }
        ],
        system: [
          // SHUTDOWN must be standalone command (followed by ; or end or whitespace, not part of identifier)
          { pattern: /\bSHUTDOWN\s*(?:;|\s|$)/im, code: 'SHUTDOWN', message: '🔴 SYSTEM: Shutdown database is forbidden / 禁止關閉資料庫' },
          { pattern: /\bRESET\s+MASTER\b/i, code: 'RESET_MASTER', message: '🔴 SYSTEM: Reset master is forbidden / 禁止重置主庫' },
          { pattern: /\bRESET\s+SLAVE\b/i, code: 'RESET_SLAVE', message: '🔴 SYSTEM: Reset slave is forbidden / 禁止重置從庫' },
          { pattern: /\bSTOP\s+SLAVE\b/i, code: 'STOP_SLAVE', message: '🔴 SYSTEM: Stop replication is forbidden / 禁止停止複製' },
          { pattern: /\bCHANGE\s+MASTER\b/i, code: 'CHANGE_MASTER', message: '🔴 SYSTEM: Change master config is forbidden / 禁止變更主庫設定' },
          { pattern: /\bSET\s+GLOBAL\s+/i, code: 'SET_GLOBAL', message: '🔴 SYSTEM: Change global settings is forbidden / 禁止變更全域設定' },
          { pattern: /\bKILL\s+(?:CONNECTION|QUERY)\s+/i, code: 'KILL', message: '🔴 SYSTEM: Kill connection/query is forbidden / 禁止終止連線/查詢' }
        ]
      },

      // ========================================
      // 🟠 危險操作 - 可用 --allow-dangerous 放行
      // ========================================
      dangerous: {
        dataLoss: [
          { pattern: /TRUNCATE\s+TABLE/i, code: 'TRUNCATE_TABLE', message: '🟠 DATA LOSS: TRUNCATE TABLE will clear all data / 會清空全表資料', suggestion: 'Use DELETE FROM table WHERE condition instead / 建議改用 DELETE FROM table WHERE condition' }
        ],
        blocking: [
          { pattern: /LOCK\s+TABLE/i, code: 'LOCK_TABLE', message: '🟠 BLOCKING: LOCK TABLE will block all queries / 會阻塞所有查詢', suggestion: 'Consider using transaction isolation level or row locks / 考慮使用交易隔離等級或行鎖' },
          { pattern: /ALTER\s+TABLE\s+(?:`[^`]+`|\w+)\s+(?:MODIFY|CHANGE)\s+(?:COLUMN\s+)?\w+\s+\w+/i, code: 'ALTER_TABLE_MODIFY', message: '🟠 BLOCKING: MODIFY/CHANGE COLUMN may rebuild table and cause long lock / 修改欄位型別可能重建表並長時間鎖表', suggestion: 'Test in staging, consider pt-online-schema-change / 先在測試環境驗證，考慮 pt-online-schema-change' },
          { pattern: /ALTER\s+TABLE\s+(?:`[^`]+`|\w+)\s+(?:CONVERT\s+TO\s+CHARACTER\s+SET|ENGINE\s*=)/i, code: 'ALTER_TABLE_REBUILD', message: '🟠 BLOCKING: This ALTER requires full table rebuild / 此 ALTER 需要完整重建表', suggestion: 'Use pt-online-schema-change for large tables / 大表建議用 pt-online-schema-change' },
          { pattern: /SELECT\s+[\s\S]*?\s+FOR\s+UPDATE/i, code: 'SELECT_FOR_UPDATE', message: '🟠 BLOCKING: SELECT FOR UPDATE causes exclusive row lock / 會造成排他行鎖', suggestion: 'Confirm if lock is needed, consider optimistic locking / 確認是否真的需要鎖定，考慮使用樂觀鎖' },
          { pattern: /SELECT\s+[\s\S]*?\s+LOCK\s+IN\s+SHARE\s+MODE/i, code: 'LOCK_IN_SHARE_MODE', message: '🟠 BLOCKING: LOCK IN SHARE MODE causes shared row lock / 會造成共享行鎖', suggestion: 'Confirm if shared lock is needed / 確認是否真的需要共享鎖' }
        ],
        bulkOperation: [
          { pattern: /DELETE\s+FROM\s+(?:`[^`]+`|\w+)\s*(?:;|$)/i, code: 'DELETE_ALL', message: '🟠 DATA RISK: DELETE without WHERE will delete all rows / 缺少 WHERE 條件會刪除全表資料', suggestion: 'Add WHERE condition / 請加上 WHERE 條件' },
          { pattern: /UPDATE\s+(?:`[^`]+`|\w+)\s+SET\s+[^;]*(?:;|$)(?![\s\S]*WHERE)/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: UPDATE without WHERE will update all rows / 缺少 WHERE 條件會更新全表資料', suggestion: 'Add WHERE condition / 請加上 WHERE 條件' }
        ],
        schemaChange: [
          { pattern: /ALTER\s+TABLE\s+(?:`[^`]+`|\w+)\s+DROP\s+COLUMN/i, code: 'DROP_COLUMN', message: '🟠 DATA LOSS: DROP COLUMN will permanently delete column data / 會永久刪除欄位資料', suggestion: 'Confirm column is no longer used / 先確認該欄位已無使用' },
          { pattern: /RENAME\s+TABLE/i, code: 'RENAME_TABLE', message: '🟠 BREAKING: RENAME TABLE may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated table references / 確認所有應用程式都已更新表名引用' },
          { pattern: /ALTER\s+TABLE\s+(?:`[^`]+`|\w+)\s+RENAME\s+TO/i, code: 'ALTER_RENAME', message: '🟠 BREAKING: RENAME TABLE may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated table references / 確認所有應用程式都已更新表名引用' },
          { pattern: /MODIFY\s+COLUMN\s+\w+\s+\w+/i, code: 'MODIFY_COLUMN', message: '🟠 DATA RISK: MODIFY COLUMN may cause data conversion failure / 可能造成資料轉換失敗', suggestion: 'Test in staging environment first / 先在測試環境驗證' },
          { pattern: /CHANGE\s+COLUMN/i, code: 'CHANGE_COLUMN', message: '🟠 DATA RISK: CHANGE COLUMN may cause data conversion failure / 可能造成資料轉換失敗', suggestion: 'Test in staging environment first / 先在測試環境驗證' },
          { pattern: /DROP\s+INDEX/i, code: 'DROP_INDEX', message: '🟠 PERFORMANCE: DROP INDEX may affect query performance / 可能影響查詢效能', suggestion: 'Confirm index is no longer used / 確認該索引已無查詢使用' },
          { pattern: /DROP\s+(?:PRIMARY\s+)?KEY/i, code: 'DROP_KEY', message: '🟠 BREAKING: DROP KEY may affect data integrity / 可能影響資料完整性', suggestion: 'Confirm foreign key relations are handled / 確認外鍵關聯已處理' },
          { pattern: /DROP\s+FOREIGN\s+KEY/i, code: 'DROP_FOREIGN_KEY', message: '🟠 BREAKING: DROP FOREIGN KEY removes data integrity constraint / 會移除資料完整性約束', suggestion: 'Confirm app layer has validation / 確認應用程式層有對應驗證' }
        ]
      },

      // ========================================
      // 🟡 警告提示 - 不阻擋執行
      // ========================================
      warnings: {
        operations: [
          { pattern: /ALTER\s+TABLE\s+(?:`[^`]+`|\w+)\s+ADD\s+COLUMN/i, message: '⚠️ ALTER TABLE ADD COLUMN may take long on large tables / 在大表上可能需要較長時間' },
          { pattern: /ADD\s+(?:CONSTRAINT\s+)?\w*\s*NOT\s+NULL(?!\s+DEFAULT)/i, message: '⚠️ Adding NOT NULL column should have DEFAULT value / 新增 NOT NULL 欄位建議搭配 DEFAULT 值' },
          { pattern: /AUTO_INCREMENT\s*=/i, message: '⚠️ Manual AUTO_INCREMENT may cause ID conflicts / 手動設定 AUTO_INCREMENT 可能造成 ID 衝突' },
          { pattern: /ENGINE\s*=\s*MyISAM/i, message: '⚠️ MyISAM does not support transactions, use InnoDB / MyISAM 引擎不支援交易，建議使用 InnoDB' },
          { pattern: /CHARSET\s*=\s*(?:latin1|utf8[^m])/i, message: '⚠️ Recommend using utf8mb4 charset / 建議使用 utf8mb4 字元集' },
          { pattern: /\b(?:FLOAT|DOUBLE)\b/i, message: '⚠️ FLOAT/DOUBLE has precision issues, use DECIMAL for money / 有精度問題，金額建議用 DECIMAL' },
          { pattern: /DATETIME(?!\s*\(\d+\))/i, message: '⚠️ DATETIME without precision truncates microseconds / 沒有指定精度，微秒會被截斷' },
          { pattern: /ON\s+DELETE\s+CASCADE/i, message: '⚠️ ON DELETE CASCADE may cause cascading deletes / 可能造成連鎖刪除' },
          { pattern: /ON\s+UPDATE\s+CASCADE/i, message: '⚠️ ON UPDATE CASCADE may cause cascading updates / 可能造成連鎖更新' },
          { pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+/i, message: '⚠️ CREATE INDEX may take long on large tables (online DDL in MariaDB 10.4+) / 大表上建索引可能較久（MariaDB 10.4+ 為線上操作）' }
        ]
      },

      // ========================================
      // 🟡 可疑名稱檢測 - 資料庫/表/欄位名稱包含危險關鍵字
      // ========================================
      suspiciousNames: {
        // 這些關鍵字出現在識別符（表名/欄位名）中時發出警告
        keywords: [
          'drop_database', 'dropdatabase', 'drop_schema', 'dropschema',
          'truncate', 'shutdown', 'reset_master', 'reset_slave',
          'grant_all', 'revoke_all', 'create_user', 'drop_user',
          'delete_all', 'deleteall', 'purge', 'destroy',
          'remove_all', 'removeall', 'wipe', 'wipeall'
        ],
        message: '⚠️ SUSPICIOUS NAME: Identifier contains dangerous keyword which may cause false positive/negative detection'
      },

      // ========================================
      // CREATE/DROP 配對檢測
      // ========================================
      createDropPairs: {
        create: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i,
        drop: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i
      },

      // ========================================
      // 🔶 效能檢測 - Performance Checks
      // ========================================
      performance: {
        // 閾值設定 (可透過 config.performance.thresholds 覆寫)
        thresholds: {
          maxQueryLength: this.config?.performance?.thresholds?.maxQueryLength ?? 5000,
          maxTotalLength: this.config?.performance?.thresholds?.maxTotalLength ?? 50000,
          maxIndexesPerMigration: this.config?.performance?.thresholds?.maxIndexesPerMigration ?? 5,
          maxAlterTablesPerMigration: this.config?.performance?.thresholds?.maxAlterTablesPerMigration ?? 10,
          maxStatementsPerMigration: this.config?.performance?.thresholds?.maxStatementsPerMigration ?? 50,
          maxColumnsPerInsert: this.config?.performance?.thresholds?.maxColumnsPerInsert ?? 20,
          maxJoinsPerQuery: this.config?.performance?.thresholds?.maxJoinsPerQuery ?? 5,
          maxSubqueries: this.config?.performance?.thresholds?.maxSubqueries ?? 3
        },
        // 效能警告訊息
        messages: {
          queryTooLong: '🔶 PERFORMANCE: Query is very long ({length} chars), may cause timeout or be hard to debug / 查詢過長 ({length} 字元)，可能造成超時或難以除錯',
          migrationTooLong: '🔶 PERFORMANCE: Migration file is very long ({length} chars), consider splitting / Migration 檔案過長 ({length} 字元)，建議拆分',
          tooManyIndexes: '🔶 PERFORMANCE: Creating {count} indexes in one migration may cause long lock time / 單次建立 {count} 個索引可能造成長時間鎖定',
          tooManyAlterTables: '🔶 PERFORMANCE: {count} ALTER TABLE statements in one migration may cause performance issues / 單次 {count} 個 ALTER TABLE 可能影響效能',
          tooManyStatements: '🔶 PERFORMANCE: {count} statements in one migration, consider splitting / 單次 {count} 個語句，建議拆分',
          complexInsert: '🔶 PERFORMANCE: INSERT with {count} columns may indicate denormalized data / INSERT 有 {count} 個欄位，可能表示資料未正規化',
          tooManyJoins: '🔶 PERFORMANCE: Query has {count} JOINs, may be slow on large tables / 查詢有 {count} 個 JOIN，大表可能很慢',
          tooManySubqueries: '🔶 PERFORMANCE: Query has {count} subqueries, consider using JOINs or CTEs / 查詢有 {count} 個子查詢，建議改用 JOIN 或 CTE',
          multipleIndexOnSameTable: '🔶 PERFORMANCE: Multiple indexes on table "{table}" in same migration, consider combining / 同一 migration 對 "{table}" 建立多個索引，建議合併',
          fullTableScan: '🔶 PERFORMANCE: Query may cause full table scan (no WHERE or index hint) / 查詢可能造成全表掃描',
          selectStar: '🔶 PERFORMANCE: SELECT * may fetch unnecessary data, specify columns / SELECT * 可能取得不必要資料，建議指定欄位',
          orderByWithoutIndex: '🔶 PERFORMANCE: ORDER BY without LIMIT on large result set may be slow / 大結果集的 ORDER BY 沒有 LIMIT 可能很慢'
        }
      }
    };
  }

  async connect() {
    try {
      // Support both flat config and nested config.mariadb
      const dbConfig = this.config.mariadb || this.config;
      const dbName = dbConfig.database;
      
      // 🔧 First connect without specifying database to avoid "unknown database" error
      const tempConnection = await mysql.createConnection({
        host: dbConfig.host || 'localhost',
        port: dbConfig.port || 3306,
        user: dbConfig.user || 'root',
        password: dbConfig.password || '',
        multipleStatements: true
      });
      
      // 🛡️ Auto-create database if it doesn't exist (for development convenience)
      if (dbName) {
        await tempConnection.execute(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` 
           DEFAULT CHARACTER SET utf8mb4 
           DEFAULT COLLATE utf8mb4_unicode_ci`
        );
        await tempConnection.end();
        
        // Now connect to the specified database
        this.connection = await mysql.createConnection({
          host: dbConfig.host || 'localhost',
          port: dbConfig.port || 3306,
          user: dbConfig.user || 'root',
          password: dbConfig.password || '',
          database: dbName,
          multipleStatements: true
        });
      } else {
        this.connection = tempConnection;
      }

      // Ensure changelog table exists (DDL/versioned mode only;
      // DCL/repeatable mode uses checksumTable, not changelogTable)
      if (this.config.mode !== 'repeatable') {
        await this.ensureChangelogTable();
      }

      return this.connection;
    } catch (error) {
      throw new Error(`MariaDB connection failed: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }

  async ensureChangelogTable() {
    const dbConfig = this.config.mariadb || this.config;
    const dbName = dbConfig.database;

    // Re-create the database if it was dropped by a DOWN migration
    // (e.g., 20260101000000-create-database.sql does DROP DATABASE in its DOWN section)
    if (dbName) {
      await this.connection.execute(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`
      );
      await this.connection.execute(`USE \`${dbName}\``);
    }

    // Use fully qualified table name so this works regardless of connection context
    const qualifiedTable = dbName ? `\`${dbName}\`.${this.changelogTable}` : this.changelogTable;
    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async status() {
    try {
      // DCL/repeatable mode does not use the DDL changelog table (schema_migrations).
      // Calling adapter.status() in DCL mode would create schema_migrations and then
      // query it. Return empty DDL status instead — use `dcl:status` for DCL migration status.
      if (this.config.mode === 'repeatable') {
        return { pending: [], applied: [], total: 0 };
      }

      // Ensure DB + changelog table exist (may have been dropped by a DOWN migration)
      await this.ensureChangelogTable();

      // Get applied migrations from changelog
      const [rows] = await this.connection.execute(
        `SELECT id, applied_at FROM ${this.changelogTable} ORDER BY applied_at`
      );
      const appliedIds = new Set(rows.map(r => r.id));

      // Get all migration files
      const migrationsDir = this.config.migrationsDir;
      const files = await fs.readdir(migrationsDir);
      const migrationFiles = files.filter(f => f.endsWith('.sql')).sort();

      const pending = [];
      const applied = [];

      for (const file of migrationFiles) {
        const id = file.replace('.sql', '');
        if (appliedIds.has(id)) {
          const row = rows.find(r => r.id === id);
          applied.push({
            fileName: file,
            appliedAt: row.applied_at
          });
        } else {
          pending.push(file);
        }
      }

      return {
        pending,
        applied,
        total: migrationFiles.length
      };
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Get list of migration files
   */
  async getMigrationFiles() {
    const migrationsDir = this.config.migrationsDir;
    const files = await fs.readdir(migrationsDir);
    return files.filter(f => f.endsWith('.sql')).sort();
  }

  /**
   * Mark migrations as applied without executing them
   * Used for existing databases (baseline)
   * 
   * @param {string[]} files - Array of migration filenames to mark as applied
   * @returns {Promise<{marked: string[], errors: string[]}>}
   */
  async baseline(files) {
    const result = {
      marked: [],
      errors: []
    };

    try {
      await this.ensureChangelogTable();
      
      for (const file of files) {
        try {
          const id = file.replace('.sql', '');
          await this.connection.execute(
            `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
            [id]
          );
          result.marked.push(file);
        } catch (error) {
          // Ignore duplicate key errors (already applied)
          if (error.code !== 'ER_DUP_ENTRY') {
            result.errors.push(`${file}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  async up(options = {}) {
    const result = {
      applied: [],
      errors: []
    };

    try {
      const status = await this.status();
      let pendingMigrations = status.pending;
      
      // Filter by target (up to and including)
      if (options.target) {
        const targetIndex = pendingMigrations.findIndex(f => 
          f === options.target || f.includes(options.target)
        );
        if (targetIndex === -1) {
          result.errors.push(`Target migration not found: ${options.target}`);
          return result;
        }
        pendingMigrations = pendingMigrations.slice(0, targetIndex + 1);
      }
      
      // Filter by only (specific migration)
      if (options.only) {
        const onlyFile = pendingMigrations.find(f => 
          f === options.only || f.includes(options.only)
        );
        if (!onlyFile) {
          result.errors.push(`Migration not found in pending: ${options.only}`);
          return result;
        }
        pendingMigrations = [onlyFile];
      }
      
      const dbConfig = this.config.mariadb || this.config;
      const dbName = dbConfig.database;

      for (const file of pendingMigrations) {
        try {
          const filePath = path.join(this.config.migrationsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Extract UP section
          const upSQL = this.extractSection(content, 'Up');
          
          if (upSQL) {
            // Prepend USE <db> directly into the SQL so the correct database
            // context is guaranteed within the same multi-statement execution.
            // This means migration files don't need to include "USE <db>" themselves.
            const wrappedUpSQL = dbName ? `USE \`${dbName}\`;\n${upSQL}` : upSQL;

            // Use query() for multi-statement support
            await this.connection.query(wrappedUpSQL);
            
            // Record in changelog
            const id = file.replace('.sql', '');
            await this.connection.execute(
              `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
              [id]
            );
            
            result.applied.push(file);
          }
        } catch (error) {
          result.errors.push(`${file}: ${error.message}`);
          break; // Stop on first error
        }
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Run migration with sanity check
   * Supports embedded sanity check SQL comments
   * 
   * SQL format:
   *   -- +migrate Up
   *   -- +sanity PreCheck
   *   SELECT COUNT(*) AS cnt FROM some_table WHERE condition;
   *   -- -sanity PreCheck
   *   -- Main migration SQL here
   *   -- +sanity PostCheck  
   *   SELECT 1 FROM information_schema.COLUMNS WHERE...
   *   -- -sanity PostCheck
   *   
   *   -- +migrate Down
   *   ...
   * 
   * @param {Object} options
   * @param {boolean} options.verbose - Enable verbose logging
   * @returns {Promise<Object>}
   */
  async upWithSanityCheck(options = {}) {
    const result = {
      applied: [],
      errors: [],
      sanityResults: []
    };

    try {
      const status = await this.status();
      
      for (const file of status.pending) {
        try {
          const filePath = path.join(this.config.migrationsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Extract sections
          const upSQL = this.extractSection(content, 'Up');
          const downSQL = this.extractSection(content, 'Down');
          const preCheckSQL = this.extractSanitySection(content, 'PreCheck');
          const postCheckSQL = this.extractSanitySection(content, 'PostCheck');

          const context = {
            connection: this.connection,
            database: this.config.database,
            config: this.config
          };

          // If sanity checks are defined, use the sanity checker
          if (preCheckSQL || postCheckSQL) {
            console.log(`\n🔍 Running ${file} with sanity checks...`);

            const checker = new SanityChecker({
              enabled: true,
              autoRollback: this.config.sanityCheck?.autoRollback ?? true,
              timeoutMs: this.config.sanityCheck?.timeoutMs ?? 30000,
              verbose: options.verbose ?? this.config.sanityCheck?.verbose ?? true
            });

            const sanityResult = await checker.runWithSanityCheck({
              up: async () => {
                if (upSQL) {
                  const dbName = (this.config.mariadb || this.config).database;
                  const wrappedUpSQL = dbName ? `USE \`${dbName}\`;\n${upSQL}` : upSQL;
                  await this.connection.query(wrappedUpSQL);
                  const id = file.replace('.sql', '');
                  await this.connection.execute(
                    `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
                    [id]
                  );
                }
              },
              down: async () => {
                if (downSQL) {
                  const dbName = (this.config.mariadb || this.config).database;
                  const wrappedDownSQL = dbName ? `USE \`${dbName}\`;\n${downSQL}` : downSQL;
                  await this.connection.query(wrappedDownSQL);
                  const id = file.replace('.sql', '');
                  await this.connection.execute(
                    `DELETE FROM ${this.changelogTable} WHERE id = ?`,
                    [id]
                  );
                }
              },
              preCheck: preCheckSQL ? async () => {
                return await this.executeSanityCheck(this.connection, preCheckSQL);
              } : null,
              postCheck: postCheckSQL ? async () => {
                return await this.executeSanityCheck(this.connection, postCheckSQL);
              } : null,
              context
            });

            result.sanityResults.push({
              file,
              ...sanityResult
            });

            if (sanityResult.success) {
              result.applied.push(file);
            } else {
              result.errors.push(`${file}: ${sanityResult.error}`);
              if (!sanityResult.rolledBack) {
                break;
              }
            }
          } else {
            // No sanity checks, run normally (same behaviour as up())
            if (upSQL) {
              console.log(`\n🔍 Running ${file} (no sanity checks)...`);
              const startTime = Date.now();
              const dbName = (this.config.mariadb || this.config).database;
              const wrappedUpSQL = dbName ? `USE \`${dbName}\`;\n${upSQL}` : upSQL;
              await this.connection.query(wrappedUpSQL);
              const id = file.replace('.sql', '');
              await this.connection.execute(
                `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
                [id]
              );
              result.applied.push(file);
              result.sanityResults.push({
                file,
                success: true,
                skipped: true,
                duration: Date.now() - startTime
              });
            }
          }
        } catch (error) {
          result.errors.push(`${file}: ${error.message}`);
          break;
        }
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Extract sanity check section from SQL content
   * Supports three formats (in priority order):
   * 1. Explicit close: -- +sanity PreCheck ... -- -sanity PreCheck
   * 2. END_CHECK close: -- +sanity PreCheck ... -- END_CHECK
   * 3. Implicit close: -- +sanity PreCheck ... (ends at next -- +migrate or -- +sanity)
   */
  extractSanitySection(content, sectionName) {
    // Try explicit close first: -- +sanity ... -- -sanity
    const explicitRegex = new RegExp(
      `--\\s*\\+sanity\\s+${sectionName}\\s*\\n([\\s\\S]*?)--\\s*-sanity\\s+${sectionName}`,
      'i'
    );
    let match = content.match(explicitRegex);
    if (match) {
      return match[1].trim();
    }
    
    // Try END_CHECK close: -- +sanity ... -- END_CHECK
    const endCheckRegex = new RegExp(
      `--\\s*\\+sanity\\s+${sectionName}\\s*\\n([\\s\\S]*?)--\\s*END_CHECK`,
      'i'
    );
    match = content.match(endCheckRegex);
    if (match) {
      return match[1].trim();
    }

    // Try implicit close: -- +sanity ... ends at next -- +migrate or -- +sanity
    const implicitRegex = new RegExp(
      `--\\s*\\+sanity\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=--\\s*\\+migrate|--\\s*\\+sanity|$)`,
      'i'
    );
    match = content.match(implicitRegex);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
    
    return null;
  }

  /**
   * Strip all sanity check blocks from SQL content.
   * Removes everything between -- +sanity ... and its closing boundary
   * (-- -sanity, -- END_CHECK, or next -- +migrate / -- +sanity).
   * Used to prevent raw SQL in sanity blocks from leaking into Up/Down sections.
   */
  stripSanityBlocks(content) {
    // Strip explicit close: -- +sanity ... -- -sanity ...
    let result = content.replace(
      /--\s*\+sanity\s+\w+\s*\n[\s\S]*?--\s*-sanity\s+\w+[^\n]*/gi,
      ''
    );
    // Strip END_CHECK close: -- +sanity ... -- END_CHECK
    result = result.replace(
      /--\s*\+sanity\s+\w+\s*\n[\s\S]*?--\s*END_CHECK[^\n]*/gi,
      ''
    );
    // Strip implicit close: -- +sanity ... up to next -- +migrate or -- +sanity
    result = result.replace(
      /--\s*\+sanity\s+\w+\s*\n[\s\S]*?(?=--\s*\+migrate|--\s*\+sanity|$)/gi,
      ''
    );
    return result;
  }

  /**
   * Execute sanity check section and interpret results.
   *
   * Supports two formats (can be mixed):
   * 1. Legacy directive format:
   *      -- EXPECT_ROWS: SELECT 1 FROM t;
   *      -- EXPECT_NO_ROWS: SELECT 1 FROM t;
   * 2. Raw SQL format (default = EXPECT_ROWS):
   *      SELECT 1 FROM information_schema.COLUMNS
   *        WHERE COLUMN_NAME='platform';
   *    Statements are split by ';'. Multi-line SQL is supported.
   *    0 rows returned → check fails → triggers rollback.
   *
   * Returns { success: true/false, error: string, details: [] }
   */
  async executeSanityCheck(connection, sanitySection) {
    const conn = connection || this.connection;
    const details = [];

    // Phase 1: Process legacy -- EXPECT_ROWS: / -- EXPECT_NO_ROWS: directives
    // Phase 2: Collect remaining raw SQL lines and split by ';'
    const rawSQLBuffer = [];
    const lines = sanitySection.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Skip empty lines
      if (!trimmedLine) continue;

      // Parse legacy EXPECT_ROWS directive
      const expectRowsMatch = trimmedLine.match(/^--\s*EXPECT_ROWS:\s*(.+)$/i);
      if (expectRowsMatch) {
        const sql = expectRowsMatch[1].trim().replace(/;$/, '');
        const result = await this._execExpectRows(conn, sql, details);
        if (result) return result; // failed
        continue;
      }
      
      // Parse legacy EXPECT_NO_ROWS directive
      const expectNoRowsMatch = trimmedLine.match(/^--\s*EXPECT_NO_ROWS:\s*(.+)$/i);
      if (expectNoRowsMatch) {
        const sql = expectNoRowsMatch[1].trim().replace(/;$/, '');
        const result = await this._execExpectNoRows(conn, sql, details);
        if (result) return result; // failed
        continue;
      }

      // Skip pure comment lines (not EXPECT directives)
      if (/^--/.test(trimmedLine)) continue;

      // Collect raw SQL lines
      rawSQLBuffer.push(line);
    }

    // Phase 2: Process raw SQL buffer — split by ';' and execute each
    if (rawSQLBuffer.length > 0) {
      const rawSQL = rawSQLBuffer.join('\n');
      const statements = rawSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      for (const sql of statements) {
        const result = await this._execExpectRows(conn, sql, details);
        if (result) return result; // failed
      }
    }
    
    return { success: true, details };
  }

  /** @private Execute a single EXPECT_ROWS check. Returns failure object or null on success. */
  async _execExpectRows(conn, sql, details) {
    try {
      const [rows] = await conn.execute(sql);
      if (rows.length === 0) {
        return {
          success: false,
          error: `Sanity check failed: Query returned no rows - ${sql.replace(/\s+/g, ' ').slice(0, 200)}`,
          details
        };
      }
      details.push(`✓ Check passed: ${rows.length} row(s)`);
      return null;
    } catch (error) {
      return {
        success: false,
        error: `Sanity check SQL error: ${error.message}`,
        details
      };
    }
  }

  /** @private Execute a single EXPECT_NO_ROWS check. Returns failure object or null on success. */
  async _execExpectNoRows(conn, sql, details) {
    try {
      const [rows] = await conn.execute(sql);
      if (rows.length > 0) {
        return {
          success: false,
          error: `EXPECT_NO_ROWS failed: Query returned ${rows.length} row(s) - ${sql.replace(/\s+/g, ' ').slice(0, 200)}`,
          details
        };
      }
      details.push(`✓ EXPECT_NO_ROWS passed: 0 rows`);
      return null;
    } catch (error) {
      return {
        success: false,
        error: `EXPECT_NO_ROWS SQL error: ${error.message}`,
        details
      };
    }
  }

  /**
   * Execute sanity check SQL and interpret results (legacy single SQL version)
   * Returns { success: true/false, error: string, details: [] }
   */
  async executeSanityCheckSQL(sql) {
    try {
      const [rows] = await this.connection.execute(sql);
      
      // Interpret results - look for common patterns
      // If query returns rows with 'success' or 'valid' column
      if (rows.length > 0) {
        const firstRow = rows[0];
        
        // Check for explicit success/valid column
        if ('success' in firstRow) {
          return {
            success: Boolean(firstRow.success),
            error: firstRow.error || (firstRow.success ? null : 'Sanity check returned success=false'),
            details: firstRow.details ? [firstRow.details] : []
          };
        }
        
        if ('valid' in firstRow) {
          return {
            success: Boolean(firstRow.valid),
            error: firstRow.error || (firstRow.valid ? null : 'Sanity check returned valid=false'),
            details: []
          };
        }

        // Check for count-based checks (count should be > 0 for existence, or specific value)
        if ('cnt' in firstRow || 'count' in firstRow) {
          const count = firstRow.cnt ?? firstRow.count;
          // If there's an expected column, compare
          if ('expected' in firstRow) {
            const success = count === firstRow.expected;
            return {
              success,
              error: success ? null : `Count mismatch: expected ${firstRow.expected}, got ${count}`,
              details: [`Count: ${count}`]
            };
          }
          // Otherwise, just return the count info
          return {
            success: true,
            details: [`Count: ${count}`]
          };
        }

        // If query returned rows without special columns, consider it success
        return {
          success: true,
          details: [`Query returned ${rows.length} row(s)`]
        };
      }

      // Empty result set - might be intentional (checking non-existence)
      return {
        success: true,
        details: ['Query returned no rows']
      };
    } catch (error) {
      return {
        success: false,
        error: `Sanity check SQL error: ${error.message}`
      };
    }
  }

  async down(count = 1) {
    const result = {
      rolledBack: [],
      errors: []
    };

    try {
      const status = await this.status();
      const toRollback = status.applied.slice(-count).reverse();
      
      for (const migration of toRollback) {
        try {
          const filePath = path.join(this.config.migrationsDir, migration.fileName);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Extract DOWN section
          const downSQL = this.extractSection(content, 'Down');
          
          if (downSQL) {
            // Remove from changelog BEFORE executing DOWN SQL.
            // This prevents "table/database doesn't exist" errors when
            // the DOWN migration drops the very database that contains
            // the changelog table (e.g., DROP DATABASE in down section).
            const id = migration.fileName.replace('.sql', '');
            await this.connection.execute(
              `DELETE FROM ${this.changelogTable} WHERE id = ?`,
              [id]
            );

            try {
              // Prepend USE <db> so the correct database context is set
              // within the same multi-statement execution.
              const dbConfigDown = this.config.mariadb || this.config;
              const wrappedDownSQL = dbConfigDown.database
                ? `USE \`${dbConfigDown.database}\`;\n${downSQL}`
                : downSQL;

              // Use query() for multi-statement support
              await this.connection.query(wrappedDownSQL);
            } catch (downError) {
              // DOWN SQL failed — restore the changelog entry so state stays consistent
              try {
                await this.connection.execute(
                  `INSERT IGNORE INTO ${this.changelogTable} (id) VALUES (?)`,
                  [id]
                );
              } catch {
                // If restore also fails (e.g. DB was dropped), ignore —
                // the database is gone so the migration is effectively rolled back
              }
              throw downError;
            }
            
            result.rolledBack.push(migration.fileName);
          }
        } catch (error) {
          result.errors.push(`${migration.fileName}: ${error.message}`);
          break;
        }
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  async create(name) {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fileName = `${timestamp}-${name}.sql`;
    const filePath = path.join(this.config.migrationsDir, fileName);

    const template = `-- +migrate Up
-- SQL in this section is executed when the migration is applied.


-- +migrate Down
-- SQL in this section is executed when the migration is rolled back.

`;

    await fs.writeFile(filePath, template);
    return fileName;
  }

  /**
   * Create a new DCL (Repeatable) migration file with R__ prefix
   * @param {string} name - Migration name
   * @param {string} sequenceNumber - Optional sequence number (e.g., '001', '002')
   * @returns {Promise<string>} - Created file name
   */
  async createDCL(name, sequenceNumber = '') {
    // Generate filename: R__001_name.sql or R__name.sql
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const prefix = sequenceNumber ? `R__${sequenceNumber}_` : 'R__';
    const fileName = `${prefix}${sanitizedName}.sql`;
    const filePath = path.join(this.config.migrationsDir, fileName);

    // Check if file already exists
    try {
      await fs.access(filePath);
      throw new Error(`DCL migration file already exists: ${fileName}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const template = `-- DCL Repeatable Migration: ${name}
-- File: ${fileName}
-- Created: ${new Date().toISOString()}
--
-- ⚠️  IMPORTANT: This script must be IDEMPOTENT!
-- It will run whenever the checksum changes.
-- Always use IF NOT EXISTS / IF EXISTS patterns!
-- ============================================

-- Example: Create user (idempotent)
-- CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'password';

-- Example: Grant permissions (idempotent by nature)
-- GRANT SELECT ON mydb.* TO 'app_readonly'@'%';

-- Example: Revoke then Grant for exact permissions
-- REVOKE ALL PRIVILEGES ON mydb.* FROM 'app_user'@'%';
-- GRANT SELECT, INSERT, UPDATE ON mydb.* TO 'app_user'@'%';

-- Apply changes
-- FLUSH PRIVILEGES;

-- Your DCL statements here:

`;

    await fs.writeFile(filePath, template);
    return fileName;
  }

  async validate(options = {}) {
    const results = {
      valid: true,
      results: []
    };

    try {
      const migrationsDir = this.config.migrationsDir;
      const files = await fs.readdir(migrationsDir);
      const migrationFiles = files.filter(f => f.endsWith('.sql'));

      for (const file of migrationFiles) {
        const filePath = path.join(migrationsDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const fileResult = this.validateContent(content, file, options);
        
        results.results.push({
          file,
          ...fileResult
        });

        if (!fileResult.valid) {
          results.valid = false;
        }
      }
    } catch (error) {
      results.valid = false;
      results.error = error.message;
    }

    return results;
  }

  /**
   * Parse per-file allow annotations from SQL comments at the top of the file.
   * Supports:
   *   -- @allow-dangerous: true
   *   -- @allow: CODE1,CODE2
   *   -- @allow-forbidden: true
   * Stops parsing at first non-comment, non-blank line.
   * @param {string} content - File content
   * @param {string} fileName - File name
   * @returns {Object} annotations
   */
  parseFileAnnotations(content, fileName) {
    const annotations = {
      allowDangerous: false,
      allowForbidden: false,
      allowedCodes: []
    };
    const commentPrefix = '--';
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('/*') || t.startsWith('*')) continue;
      if (!t.startsWith(commentPrefix)) break;
      const dangerousMatch = t.match(/--\s*@allow-dangerous\s*:\s*(.+)/i);
      if (dangerousMatch) {
        const v = dangerousMatch[1].trim().toLowerCase();
        annotations.allowDangerous = ['true', 'yes', '1'].includes(v);
      }
      const forbiddenMatch = t.match(/--\s*@allow-forbidden\s*:\s*(.+)/i);
      if (forbiddenMatch) {
        const v = forbiddenMatch[1].trim().toLowerCase();
        annotations.allowForbidden = ['true', 'yes', '1'].includes(v);
      }
      const allowMatch = t.match(/--\s*@allow\s*:\s*(.+)/i);
      if (allowMatch) {
        const codes = allowMatch[1].split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
        annotations.allowedCodes.push(...codes);
      }
    }
    return annotations;
  }

  /**
   * Validate migration content
   * @param {string} content - Migration file content
   * @param {string} fileName - File name
   * @param {Object} options - Validation options
   * @param {boolean} options.allowDangerous - Allow dangerous operations
   * @param {boolean} options.allowForbidden - Allow forbidden operations (requires approval)
   * @param {string[]} options.allowedCodes - Specific codes to allow
   */
  /**
   * Validate SQL syntax using node-sql-parser (MariaDB dialect).
   * Runs BEFORE all other validation rules.
   *
   * Skips parsing when:
   *   - File contains DELIMITER keyword (stored procedures — not supported by parser)
   *   - File has annotation: -- @skip-syntax-check: true
   *
   * @param {string} content  Raw file content
   * @param {string} fileName File name for error messages
   * @returns {{ errors: Array, warnings: Array }}
   */
  validateSQLSyntax(content, fileName) {
    const errors = [];
    const warnings = [];

    // Allow opt-out via annotation
    if (/--\s*@skip-syntax-check\s*:\s*true/i.test(content)) {
      warnings.push({ type: 'syntax-check-skipped', message: '⚠️ SQL syntax check skipped (@skip-syntax-check: true)' });
      return { errors, warnings };
    }

    // Helper: clean unicode noise from SQL before parsing
    const cleanUnicode = (sql) => sql
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .trim();

    // Helper: parse SQL with node-sql-parser; push error if syntax invalid
    const checkSQL = (sql, label, code) => {
      const clean = cleanUnicode(sql);
      if (!clean) return;
      // DELIMITER syntax — node-sql-parser doesn't support it
      if (/^\s*DELIMITER\b/im.test(clean)) {
        warnings.push({
          type: 'syntax-check-skipped',
          message: `⚠️ SQL syntax check skipped (${label}): DELIMITER syntax detected (stored procedure — not supported by parser)`
        });
        return;
      }
      try {
        const parser = new SQLParser();
        parser.astify(clean, { database: 'MariaDB' });
      } catch (e) {
        errors.push({
          type: 'syntax-error',
          code,
          message: `🔴 ${label} SQL syntax error: ${e.message.split('\n')[0]}`
        });
      }
    };

    // === 1. Check Up section (or full content for R__ files) ===
    const upSQL = this.extractSection(content, 'Up');
    const sqlToCheck = upSQL || this.stripSanityBlocks(content);

    // DCL statements (CREATE USER, GRANT, REVOKE, FLUSH PRIVILEGES, etc.) are not
    // supported by node-sql-parser — skip syntax check for files containing them
    const isDCL = /\b(?:CREATE\s+USER|DROP\s+USER|ALTER\s+USER|GRANT\s+|REVOKE\s+|FLUSH\s+PRIVILEGES|SET\s+PASSWORD\s+FOR)\b/i.test(sqlToCheck);
    // ENUM/SET column types and VALUES() function (ON DUPLICATE KEY UPDATE) are valid MariaDB
    // syntax but not supported by node-sql-parser
    const hasEnumOrSet = /\bENUM\s*\(|\bSET\s*\(|\bVALUES\s*\(\s*\w/i.test(sqlToCheck);
    if (isDCL) {
      warnings.push({
        type: 'syntax-check-skipped',
        message: '⚠️ SQL syntax check skipped: DCL statements detected (CREATE USER/GRANT/REVOKE — not supported by parser)'
      });
    } else if (hasEnumOrSet) {
      warnings.push({
        type: 'syntax-check-skipped',
        message: '⚠️ SQL syntax check skipped: ENUM/SET column type detected (not supported by parser)'
      });
    } else {
      checkSQL(sqlToCheck, 'Up', 'SQL_SYNTAX_ERROR');
    }

    // === 2. Check Down section ===
    const downSQL = this.extractSection(content, 'Down');
    if (downSQL && !isDCL && !hasEnumOrSet) {
      checkSQL(downSQL, 'Down', 'SQL_SYNTAX_ERROR_DOWN');
    }

    // === 3. Sanity block SQL syntax check (PreCheck / PostCheck) ===
    for (const section of ['PreCheck', 'PostCheck']) {
      const sanityBody = this.extractSanitySection(content, section);
      if (!sanityBody) continue;

      // Collect SQL statements from the sanity section:
      // - Legacy: -- EXPECT_ROWS: <sql> / -- EXPECT_NO_ROWS: <sql>
      // - Raw: bare SQL split by ';'
      const rawBuf = [];
      for (const line of sanityBody.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Legacy directive → extract the SQL part
        const expectMatch = trimmed.match(/^--\s*EXPECT_(?:NO_)?ROWS:\s*(.+)$/i);
        if (expectMatch) {
          rawBuf.push(expectMatch[1].trim().replace(/;$/, ''));
          continue;
        }
        // Skip pure comments
        if (/^--/.test(trimmed)) continue;
        // Raw SQL line
        rawBuf.push(line);
      }

      if (rawBuf.length === 0) continue;

      // Split collected lines by ';' into individual statements
      const statements = rawBuf.join('\n').split(';').map(s => s.trim()).filter(s => s.length > 0);

      for (const stmt of statements) {
        // Skip statements using DATABASE() — not supported by node-sql-parser
        if (/\bDATABASE\s*\(\)/i.test(stmt)) {
          warnings.push({
            type: 'syntax-check-skipped',
            message: `⚠️ Sanity ${section} SQL syntax check skipped: DATABASE() function not supported by parser`
          });
          continue;
        }
        try {
          const parser = new SQLParser();
          parser.astify(stmt, { database: 'MariaDB' });
        } catch (e) {
          errors.push({
            type: 'syntax-error',
            code: 'SANITY_SQL_SYNTAX_ERROR',
            message: `🔴 Sanity ${section} SQL syntax error: ${e.message.split('\n')[0]}`
          });
        }
      }
    }

    return { errors, warnings };
  }

  validateContent(content, fileName, options = {}) {
    // === Parse per-file annotations (-- @allow-dangerous: true / -- @allow: CODE1,CODE2) ===
    const fileAnnotations = this.parseFileAnnotations(content, fileName);
    // Merge: per-file annotations can escalate permissions, but cannot downgrade CLI flags
    const effectiveOptions = {
      ...options,
      allowDangerous: options.allowDangerous || fileAnnotations.allowDangerous,
      allowForbidden: options.allowForbidden || fileAnnotations.allowForbidden,
      allowedCodes: [...(options.allowedCodes || []), ...(fileAnnotations.allowedCodes || [])]
    };
    options = effectiveOptions;

    // === 0. SQL Syntax check via node-sql-parser (MariaDB dialect) ===
    const syntaxResult = this.validateSQLSyntax(content, fileName);

    const errors = [...syntaxResult.errors];
    const warnings = [...syntaxResult.warnings];
    const dangerousOps = [];
    const forbiddenOps = [];
    const rules = this.getValidationRules(this.config.mode);

    const upSQL = this.extractSection(content, 'Up');
    const downSQL = this.extractSection(content, 'Down');
    
    // Normalize SQL for pattern matching (remove comments, collapse whitespace)
    const normalizedContent = this.normalizeSQL(content);
    const normalizedUpSQL = this.normalizeSQL(upSQL);
    const normalizedDownSQL = this.normalizeSQL(downSQL);
    // For dangerous/warning checks: only check UP section (DOWN is rollback, destructive ops are expected).
    // Fall back to full content for R__ files without -- +migrate Up/Down markers.
    const normalizedCheckTarget = normalizedUpSQL || normalizedContent;

    // === 1. Extract created and dropped tables ===
    const createdTables = this.extractCreatedTables(upSQL);
    const droppedTablesInDown = this.extractDroppedTables(downSQL);
    const droppedTablesInUp = this.extractDroppedTables(upSQL);
    
    // === 1b. Extract created and dropped databases ===
    const hasCreateDatabaseInUp = /CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.test(normalizedUpSQL);
    const hasDropDatabaseInDown = /DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?/i.test(normalizedDownSQL);
    const hasDropDatabaseInUp = /DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?/i.test(normalizedUpSQL);

    // === 2. DDL only: Check for orphan drops in DOWN section (R__ repeatable files have no UP/DOWN) ===
    if (this.config.mode !== 'repeatable') {
      for (const dropped of droppedTablesInDown) {
        if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
          errors.push({
            type: 'orphan-drop',
            code: 'ORPHAN_DROP_DOWN',
            message: `Orphan drop: DOWN drops '${dropped}' but UP doesn't create it`
          });
        }
      }

      // === 2b. Check for orphan drops in UP section ===
      for (const dropped of droppedTablesInUp) {
        if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
          errors.push({
            type: 'orphan-drop-in-up',
            code: 'ORPHAN_DROP_UP',
            message: `Orphan drop in UP: '${dropped}' is dropped but not created in this migration`
          });
        }
      }
    }

    // Detect valid CREATE/DROP pairs (always false in repeatable mode — no UP/DOWN sections)
    const hasValidCreateDropPair = this.config.mode !== 'repeatable' &&
      createdTables.length > 0 && 
      droppedTablesInDown.every(d => createdTables.map(t => t.toLowerCase()).includes(d.toLowerCase()));

    // === 3. Check FORBIDDEN operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const rule of rules.forbidden[category]) {
        // Smart allowance: Skip DROP TABLE check if it's a valid CREATE/DROP pair
        if (hasValidCreateDropPair && rule.pattern.toString().includes('DROP\\s+TABLE')) {
          warnings.push({
            type: 'allowed-drop-for-create',
            message: `✅ [ALLOWED] DROP TABLE in down() because up() creates table`
          });
          continue;
        }
        
        // Smart allowance: CREATE DATABASE in UP section is allowed
        if (rule.code === 'DROP_DATABASE' || rule.code === 'DROP_SCHEMA') {
          // Allow DROP DATABASE/SCHEMA only in DOWN section when UP creates it
          if (hasCreateDatabaseInUp && hasDropDatabaseInDown && !hasDropDatabaseInUp) {
            warnings.push({
              type: 'allowed-drop-database',
              message: `✅ [ALLOWED] DROP DATABASE in down() because up() creates database`
            });
            continue;
          }
          // Forbid DROP DATABASE in UP section unless explicitly approved via @allow-forbidden
          if (hasDropDatabaseInUp) {
            const isAllowed = options.allowForbidden ||
              (options.allowedCodes && options.allowedCodes.includes(rule.code));
            if (isAllowed) {
              warnings.push({
                type: 'forbidden-allowed',
                code: rule.code,
                message: `⚠️ [FORCE ALLOWED] ${rule.message} (in UP section — EXPLICIT APPROVAL)`
              });
            } else {
              forbiddenOps.push({
                type: `forbidden-${category}`,
                code: rule.code,
                message: rule.message + ' (in UP section)'
              });
            }
            continue;
          }
        }

        // Use normalized content for pattern matching
        if (rule.pattern.test(normalizedContent)) {
          // dclReverse (DDL ops in DCL file) can NEVER be bypassed
          const isAbsolute = category === 'dclReverse';
          const isAllowed = !isAbsolute && (
            options.allowForbidden || 
            (options.allowedCodes && options.allowedCodes.includes(rule.code))
          );
          
          if (isAllowed) {
            warnings.push({
              type: 'forbidden-allowed',
              code: rule.code,
              message: `⚠️ [FORCE ALLOWED] ${rule.message}`
            });
          } else {
            forbiddenOps.push({
              type: `forbidden-${category}`,
              code: rule.code,
              message: rule.message
            });
          }
        }
      }
    }

    // === 4. Check DANGEROUS operations (UP section only; DOWN rollback ops are expected) ===
    for (const category of Object.keys(rules.dangerous)) {
      for (const rule of rules.dangerous[category]) {
        // Only check UP section (or full content for files without UP/DOWN markers)
        if (rule.pattern.test(normalizedCheckTarget)) {
          const isAllowed = options.allowDangerous || 
            (options.allowedCodes && options.allowedCodes.includes(rule.code));
          
          if (isAllowed) {
            warnings.push({
              type: 'dangerous-allowed',
              code: rule.code,
              message: `✅ [ALLOWED] ${rule.message}`,
              suggestion: rule.suggestion
            });
          } else {
            dangerousOps.push({
              type: `dangerous-${category}`,
              code: rule.code,
              message: rule.message,
              suggestion: rule.suggestion
            });
          }
        }
      }
    }

    // === 5. Check INSERT...SELECT (UP section only, statement-level to avoid subquery false positives) ===
    const insertSelectStatements = normalizedCheckTarget.split(';').filter(stmt =>
      /INSERT\s+(?:IGNORE\s+)?INTO\s+[\s\S]*?\bSELECT\b/i.test(stmt)
    );
    for (const stmt of insertSelectStatements) {
      // Find the FIRST SELECT after INSERT INTO (the main SELECT, not subqueries)
      const mainSelectMatch = stmt.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+[^)]*(?:\([^)]*\))?\s*(SELECT\b)/i);
      if (mainSelectMatch) {
        const afterSelect = stmt.slice(mainSelectMatch.index + mainSelectMatch[0].length);
        // Check if there's a top-level WHERE (not inside a subquery parenthesis)
        const hasTopLevelWhere = /\bWHERE\b/i.test(afterSelect);
        const hasOnDuplicateKey = /\bON\s+DUPLICATE\s+KEY\b/i.test(stmt);
        
        if (hasTopLevelWhere || hasOnDuplicateKey) {
          warnings.push({
            type: 'warning',
            message: '⚠️ INSERT...SELECT with WHERE may briefly lock source rows / INSERT...SELECT 有 WHERE 條件，可能短暫鎖定來源行'
          });
        } else {
          const isAllowed = options.allowDangerous ||
            (options.allowedCodes && options.allowedCodes.includes('INSERT_SELECT'));
          if (isAllowed) {
            warnings.push({
              type: 'dangerous-allowed',
              code: 'INSERT_SELECT',
              message: '✅ [ALLOWED] 🟠 BLOCKING: INSERT...SELECT without WHERE will lock entire source table / 無 WHERE 條件會鎖住整張來源表',
              suggestion: 'Add WHERE condition or use batch processing / 加上 WHERE 條件或分批處理'
            });
          } else {
            dangerousOps.push({
              type: 'dangerous-bulkOperation',
              code: 'INSERT_SELECT',
              message: '🟠 BLOCKING: INSERT...SELECT without WHERE will lock entire source table / 無 WHERE 條件會鎖住整張來源表',
              suggestion: 'Add WHERE condition or use batch processing / 加上 WHERE 條件或分批處理'
            });
          }
        }
      }
    }

    // === 6. Check WARNING operations (UP section only) ===
    for (const rule of rules.warnings.operations) {
      // Only check UP section (or full content for files without UP/DOWN markers)
      if (rule.pattern.test(normalizedCheckTarget)) {
        warnings.push({
          type: 'warning',
          message: rule.message
        });
      }
    }

    // === 7. Check SUSPICIOUS NAMES (identifiers containing dangerous keywords) ===
    const suspiciousNameWarnings = this.checkSuspiciousNames(content);
    warnings.push(...suspiciousNameWarnings);

    // === 8. Check PERFORMANCE ISSUES ===
    const performanceResult = this.checkPerformanceIssues(content, fileName);
    const performanceWarnings = performanceResult.warnings;
    warnings.push(...performanceWarnings);

    // === 9. DDL only: Check if DOWN section exists (R__ repeatable files have no DOWN) ===
    if (this.config.mode !== 'repeatable' && (!downSQL || downSQL.trim() === '')) {
      warnings.push({
        type: 'missing-down',
        message: '⚠️ DOWN migration is empty or missing'
      });
    }

    // Combine errors: forbidden ops + dangerous ops (when not allowed) + structural errors
    const allErrors = [...errors, ...forbiddenOps, ...dangerousOps];

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings,
      forbiddenOps,
      dangerousOps,
      suspiciousNames: suspiciousNameWarnings,
      performanceIssues: performanceWarnings,
      performanceMetrics: performanceResult.metrics,
      summary: {
        forbidden: forbiddenOps.length,
        dangerous: dangerousOps.length,
        warnings: warnings.length,
        structural: errors.length,
        suspiciousNames: suspiciousNameWarnings.length,
        performanceIssues: performanceWarnings.length
      }
    };
  }

  extractCreatedTables(sql) {
    const tables = [];
    // Remove comments first
    const cleanSQL = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Match: CREATE TABLE table_name or CREATE TABLE IF NOT EXISTS table_name
    const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
    let match;
    while ((match = regex.exec(cleanSQL)) !== null) {
      tables.push(match[1]);
    }
    return tables;
  }

  extractDroppedTables(sql) {
    const tables = [];
    // Remove comments first
    const cleanSQL = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // Match: DROP TABLE table_name or DROP TABLE IF EXISTS table_name
    const regex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
    let match;
    while ((match = regex.exec(cleanSQL)) !== null) {
      tables.push(match[1]);
    }
    return tables;
  }

  extractSection(content, section) {
    const regex = new RegExp(`--\\s*\\+migrate\\s+${section}([\\s\\S]*?)(?=--\\s*\\+migrate|$)`, 'i');
    const match = content.match(regex);
    if (!match) return '';
    // Strip any sanity check blocks that may appear inside the section
    // (raw SQL in sanity blocks must NOT be treated as migration SQL)
    const stripped = this.stripSanityBlocks(match[1]);
    return stripped.trim();
  }

  /**
   * Normalize SQL content for pattern matching
   * - Remove string literals to avoid false positives from data values
   * - Remove single-line comments (except EXPECT directives)
   * - Remove multi-line comments
   * - Collapse multiple whitespace/newlines to single space
   * - Preserve case for case-insensitive matching
   * 
   * @param {string} sql - Raw SQL content
   * @returns {string} - Normalized SQL
   */
  normalizeSQL(sql) {
    if (!sql) return '';
    return sql
      // Remove zero-width characters (Unicode confusion attack prevention)
      // Step 1: Remove zero-width characters (Unicode confusion attack prevention)
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      // Step 2: Convert fullwidth characters to halfwidth (Unicode normalization)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      // Step 3: Remove single-line comments FIRST so that apostrophes in comments
      // (e.g. "doesn't") don't interfere with the string-literal replacement below.
      // Preserve -- EXPECT_ROWS: / -- EXPECT_NO_ROWS: directives used by sanity checks.
      .replace(/--(?!\s*EXPECT).*$/gm, ' ')
      // Step 4: Remove multi-line comments /* ... */ (but detect MySQL conditional comments first)
      .replace(/\/\*[\s\S]*?\*\//g, (match) => {
        // MySQL conditional comments /*! ... */ are executed, preserve content
        if (match.startsWith('/*!')) {
          return match.slice(3, -2);
        }
        return ' ';
      })
      // Step 5: Remove string literals (single quotes) to avoid false positives from data values
      // e.g., INSERT INTO log VALUES ('DROP DATABASE test') should NOT trigger
      // Use a placeholder to preserve syntax
      .replace(/'(?:[^'\\]|\\.)*'/g, "'__STRING__'")
      // Step 6: Remove string literals (double quotes)
      .replace(/"(?:[^"\\]|\\.)*"/g, '"__STRING__"')
      // Collapse multiple whitespace/newlines to single space
      .replace(/\s+/g, ' ')
      // Trim
      .trim();
  }

  /**
   * Extract identifiers (table names, column names) from SQL for suspicious name checking
   * @param {string} sql - SQL content
   * @returns {string[]} - Array of identifiers found
   */
  extractIdentifiers(sql) {
    if (!sql) return [];
    const identifiers = [];
    
    // Match backtick-quoted identifiers
    const backtickRegex = /`([^`]+)`/g;
    let match;
    while ((match = backtickRegex.exec(sql)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Match common identifier patterns (table/column names after keywords)
    // CREATE TABLE name, ALTER TABLE name, DROP TABLE name
    const tableRegex = /(?:CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"]?(\w+)[`"]?/gi;
    while ((match = tableRegex.exec(sql)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Column names: ADD COLUMN name, DROP COLUMN name, MODIFY COLUMN name
    const columnRegex = /(?:ADD|DROP|MODIFY|CHANGE)\s+COLUMN\s+[`"]?(\w+)[`"]?/gi;
    while ((match = columnRegex.exec(sql)) !== null) {
      identifiers.push(match[1]);
    }
    
    return [...new Set(identifiers)]; // Remove duplicates
  }

  /**
   * Check for suspicious identifier names that may cause confusion
   * @param {string} sql - SQL content
   * @returns {Object[]} - Array of warnings for suspicious names
   */
  checkSuspiciousNames(sql) {
    const rules = this.getValidationRules();
    const warnings = [];
    const identifiers = this.extractIdentifiers(sql);
    
    for (const identifier of identifiers) {
      const lowerName = identifier.toLowerCase();
      for (const keyword of rules.suspiciousNames.keywords) {
        if (lowerName.includes(keyword)) {
          warnings.push({
            type: 'suspicious-name',
            identifier,
            keyword,
            message: `⚠️ SUSPICIOUS NAME: Identifier '${identifier}' contains keyword '${keyword}' - this may cause false positive/negative detection / 識別符包含危險關鍵字，可能導致誤判`
          });
        }
      }
    }
    
    return warnings;
  }

  /**
   * Check for performance issues in SQL content
   * @param {string} sql - SQL content  
   * @param {string} fileName - File name for context
   * @returns {Object} - Performance analysis result
   */
  checkPerformanceIssues(sql, fileName = '') {
    const rules = this.getValidationRules();
    const thresholds = rules.performance.thresholds;
    const messages = rules.performance.messages;
    const warnings = [];
    const metrics = {};

    if (!sql) {
      return { warnings, metrics };
    }

    // Helper to replace all occurrences of a placeholder
    const replaceAll = (str, search, replacement) => str.split(search).join(replacement);

    // 1. Check total migration length
    metrics.totalLength = sql.length;
    if (sql.length > thresholds.maxTotalLength) {
      warnings.push({
        type: 'performance-migration-length',
        code: 'MIGRATION_TOO_LONG',
        message: replaceAll(messages.migrationTooLong, '{length}', sql.length),
        value: sql.length,
        threshold: thresholds.maxTotalLength
      });
    }

    // 2. Split into statements and analyze each
    const statements = this.splitStatements(sql);
    metrics.statementCount = statements.length;

    if (statements.length > thresholds.maxStatementsPerMigration) {
      warnings.push({
        type: 'performance-statement-count',
        code: 'TOO_MANY_STATEMENTS',
        message: replaceAll(messages.tooManyStatements, '{count}', statements.length),
        value: statements.length,
        threshold: thresholds.maxStatementsPerMigration
      });
    }

    // 3. Check individual statement length
    const longStatements = [];
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (stmt.length > thresholds.maxQueryLength) {
        longStatements.push({
          index: i + 1,
          length: stmt.length,
          preview: stmt.substring(0, 100) + '...'
        });
      }
    }
    
    if (longStatements.length > 0) {
      metrics.longStatements = longStatements;
      warnings.push({
        type: 'performance-query-length',
        code: 'QUERY_TOO_LONG',
        message: replaceAll(messages.queryTooLong, '{length}', longStatements[0].length),
        details: longStatements
      });
    }

    // 4. Count CREATE INDEX statements
    const indexMatches = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?/gi) || [];
    metrics.indexCount = indexMatches.length;

    if (indexMatches.length > thresholds.maxIndexesPerMigration) {
      warnings.push({
        type: 'performance-index-count',
        code: 'TOO_MANY_INDEXES',
        message: replaceAll(messages.tooManyIndexes, '{count}', indexMatches.length),
        value: indexMatches.length,
        threshold: thresholds.maxIndexesPerMigration
      });
    }

    // 5. Check for multiple indexes on same table
    const indexesByTable = {};
    const indexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?(\w+)[`"]?\s+ON\s+[`"]?(\w+)[`"]?/gi;
    let indexMatch;
    while ((indexMatch = indexRegex.exec(sql)) !== null) {
      const tableName = indexMatch[2].toLowerCase();
      if (!indexesByTable[tableName]) {
        indexesByTable[tableName] = [];
      }
      indexesByTable[tableName].push(indexMatch[1]);
    }

    for (const [table, indexes] of Object.entries(indexesByTable)) {
      if (indexes.length > 1) {
        warnings.push({
          type: 'performance-multiple-indexes-same-table',
          code: 'MULTIPLE_INDEXES_SAME_TABLE',
          message: replaceAll(messages.multipleIndexOnSameTable, '{table}', table),
          table,
          indexes
        });
      }
    }

    // 6. Count ALTER TABLE statements
    const alterTableMatches = sql.match(/ALTER\s+TABLE\s+/gi) || [];
    metrics.alterTableCount = alterTableMatches.length;

    if (alterTableMatches.length > thresholds.maxAlterTablesPerMigration) {
      warnings.push({
        type: 'performance-alter-table-count',
        code: 'TOO_MANY_ALTER_TABLES',
        message: replaceAll(messages.tooManyAlterTables, '{count}', alterTableMatches.length),
        value: alterTableMatches.length,
        threshold: thresholds.maxAlterTablesPerMigration
      });
    }

    // 7. Check for SELECT * (code smell in migrations, usually in triggers/procedures)
    if (/SELECT\s+\*\s+FROM/i.test(sql)) {
      warnings.push({
        type: 'performance-select-star',
        code: 'SELECT_STAR',
        message: messages.selectStar
      });
    }

    // 8. Count JOINs in queries
    const joinCount = (sql.match(/\b(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+/gi) || []).length;
    metrics.joinCount = joinCount;
    
    if (joinCount > thresholds.maxJoinsPerQuery) {
      warnings.push({
        type: 'performance-too-many-joins',
        code: 'TOO_MANY_JOINS',
        message: replaceAll(messages.tooManyJoins, '{count}', joinCount),
        value: joinCount,
        threshold: thresholds.maxJoinsPerQuery
      });
    }

    // 9. Count subqueries
    const subqueryCount = (sql.match(/\(\s*SELECT\s+/gi) || []).length;
    metrics.subqueryCount = subqueryCount;

    if (subqueryCount > thresholds.maxSubqueries) {
      warnings.push({
        type: 'performance-too-many-subqueries',
        code: 'TOO_MANY_SUBQUERIES',
        message: replaceAll(messages.tooManySubqueries, '{count}', subqueryCount),
        value: subqueryCount,
        threshold: thresholds.maxSubqueries
      });
    }

    // 10. Check for ORDER BY without LIMIT (potential performance issue)
    // Simple approach: check if ORDER BY exists and LIMIT does not follow
    const hasOrderBy = /\bORDER\s+BY\b/i.test(sql);
    const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
    
    if (hasOrderBy && !hasLimit) {
      // Only warn if it's a SELECT statement (not CREATE TABLE, etc.)
      if (/\bSELECT\b[\s\S]+\bORDER\s+BY\b/i.test(sql)) {
        warnings.push({
          type: 'performance-order-by-no-limit',
          code: 'ORDER_BY_NO_LIMIT',
          message: messages.orderByWithoutIndex
        });
      }
    }

    // 11. Check INSERT column count
    const insertMatch = sql.match(/INSERT\s+INTO\s+[`"]?\w+[`"]?\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const columns = insertMatch[1].split(',').length;
      metrics.maxInsertColumns = columns;
      
      if (columns > thresholds.maxColumnsPerInsert) {
        warnings.push({
          type: 'performance-complex-insert',
          code: 'COMPLEX_INSERT',
          message: replaceAll(messages.complexInsert, '{count}', columns),
          value: columns,
          threshold: thresholds.maxColumnsPerInsert
        });
      }
    }

    return {
      warnings,
      metrics,
      summary: {
        totalWarnings: warnings.length,
        hasCriticalPerformanceIssues: warnings.some(w => 
          ['TOO_MANY_INDEXES', 'TOO_MANY_ALTER_TABLES', 'QUERY_TOO_LONG'].includes(w.code)
        )
      }
    };
  }

  /**
   * Split SQL content into individual statements
   * @param {string} sql - SQL content
   * @returns {string[]} - Array of statements
   */
  splitStatements(sql) {
    if (!sql) return [];
    
    // Remove comments first
    const cleanSQL = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Split by semicolon, but be careful with strings
    const statements = [];
    let current = '';
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < cleanSQL.length; i++) {
      const char = cleanSQL[i];
      const prevChar = cleanSQL[i - 1];
      
      // Handle string boundaries
      if ((char === "'" || char === '"') && prevChar !== '\\') {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
      }
      
      // Split on semicolon if not in string
      if (char === ';' && !inString) {
        const stmt = current.trim();
        if (stmt) {
          statements.push(stmt);
        }
        current = '';
      } else {
        current += char;
      }
    }
    
    // Add last statement if exists
    const lastStmt = current.trim();
    if (lastStmt) {
      statements.push(lastStmt);
    }
    
    return statements;
  }
}

export default MariaDBAdapter;
