/**
 * MariaDB/MySQL Adapter
 * Implements SQL migrations using sql-migrate pattern
 */

import { BaseAdapter, isRepeatableMigrationFile, selectPendingMigrations } from '../core/base-adapter.js';
import { SanityChecker, SQLChecks } from '../core/sanity-checker.js';
import { listMigrationFiles, pickDir, findExisting } from '../core/migration-dirs.js';
import { addColumnIfMissing } from '../core/sql-columns.js';
import { splitSqlStatements } from '../core/sql-statements.js';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import nodeSqlParserPkg from 'node-sql-parser';
const { Parser: SQLParser } = nodeSqlParserPkg;


/**
 * The `ssl` config option → mysql2's `ssl` connection option.
 *
 *   ssl: true                       TLS, server certificate checked against Node's default CAs
 *   ssl: { caFile: '/path/ca.pem' } TLS with that CA bundle (e.g. AWS RDS's
 *                                   global-bundle.pem, mounted from a ConfigMap)
 *   ssl: { ca, cert, key, rejectUnauthorized, … }  passed to mysql2 as-is
 *
 * caFile / certFile / keyFile are read here, so a config can point at
 * mounted files instead of reading them itself. Unset / false → no TLS.
 */
export function resolveSslOption(ssl) {
  if (!ssl) return undefined;
  if (ssl === true) return {};
  if (typeof ssl !== 'object') {
    throw new Error(`ssl must be true or an object (e.g. { caFile: '/path/ca.pem' }), got ${JSON.stringify(ssl)}`);
  }
  const { caFile, certFile, keyFile, ...rest } = ssl;
  const read = (file, what) => {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`ssl.${what}: cannot read ${file} (${err.code || err.message})`);
    }
  };
  return {
    ...rest,
    ...(caFile ? { ca: read(caFile, 'caFile') } : {}),
    ...(certFile ? { cert: read(certFile, 'certFile') } : {}),
    ...(keyFile ? { key: read(keyFile, 'keyFile') } : {})
  };
}

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
    // [schema.]table, each part bare or `quoted`
    const TBL = String.raw`(?:(?:\`[^\`]+\`|\w+)\.)?(?:\`[^\`]+\`|\w+)`;
    const re = (src, flags = 'i') => new RegExp(src, flags);
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
          // All patterns use (?:^|;)\s* to match only statement-start positions,
          // preventing false positives from GRANT privilege names (e.g. GRANT CREATE TABLE, ALTER ROUTINE, TRIGGER ON ...).
          dclReverse: [
            { pattern: /(?:^|;)\s*CREATE\s+TABLE\b/i,              code: 'CREATE_TABLE_IN_DCL',     message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*ALTER\s+TABLE\b/i,               code: 'ALTER_TABLE_IN_DCL',      message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*DROP\s+TABLE\b/i,                code: 'DROP_TABLE_IN_DCL',       message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i, code: 'CREATE_INDEX_IN_DCL',   message: '🔴 DDL: Index management should be in DDL project (Versioned) / 索引管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*DROP\s+INDEX\b/i,                code: 'DROP_INDEX_IN_DCL',       message: '🔴 DDL: Index management should be in DDL project (Versioned) / 索引管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, code: 'CREATE_VIEW_IN_DCL', message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*ALTER\s+VIEW\b/i,                code: 'ALTER_VIEW_IN_DCL',       message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*DROP\s+VIEW\b/i,                 code: 'DROP_VIEW_IN_DCL',        message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /(?:^|;)\s*CREATE\s+(?:DEFINER\s*=\S+\s+)?(?:PROCEDURE|FUNCTION)\b/i, code: 'CREATE_ROUTINE_IN_DCL', message: '🔴 DDL: Routine management should be in DDL project (Versioned) / 程序管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*DROP\s+(?:PROCEDURE|FUNCTION)\b/i, code: 'DROP_ROUTINE_IN_DCL',  message: '🔴 DDL: Routine management should be in DDL project (Versioned) / 程序管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*CREATE\s+(?:DEFINER\s*=\S+\s+)?TRIGGER\b/i, code: 'CREATE_TRIGGER_IN_DCL', message: '🔴 DDL: Trigger management should be in DDL project (Versioned) / 觸發器管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*DROP\s+TRIGGER\b/i,              code: 'DROP_TRIGGER_IN_DCL',     message: '🔴 DDL: Trigger management should be in DDL project (Versioned) / 觸發器管理應在 DDL 專案' },
            { pattern: /(?:^|;)\s*RENAME\s+TABLE\b/i,              code: 'RENAME_TABLE_IN_DCL',     message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' }
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
          // TABLE keyword is optional in MariaDB (TRUNCATE logs;)
          { pattern: /^TRUNCATE\s+(?:TABLE\s+)?[`\w]/i, code: 'TRUNCATE_TABLE', message: '🟠 DATA LOSS: TRUNCATE TABLE will clear all data / 會清空全表資料', suggestion: 'Use DELETE FROM table WHERE condition instead / 建議改用 DELETE FROM table WHERE condition' }
        ],
        blocking: [
          { pattern: /LOCK\s+TABLE/i, code: 'LOCK_TABLE', message: '🟠 BLOCKING: LOCK TABLE will block all queries / 會阻塞所有查詢', suggestion: 'Consider using transaction isolation level or row locks / 考慮使用交易隔離等級或行鎖' },
          { pattern: re(String.raw`ALTER\s+TABLE\s+${TBL}\s+(?:MODIFY|CHANGE)\s+(?:COLUMN\s+)?\w+\s+\w+`), code: 'ALTER_TABLE_MODIFY', message: '🟠 BLOCKING: MODIFY/CHANGE COLUMN may rebuild table and cause long lock / 修改欄位型別可能重建表並長時間鎖表', suggestion: 'Test in staging, consider pt-online-schema-change / 先在測試環境驗證，考慮 pt-online-schema-change' },
          { pattern: re(String.raw`ALTER\s+TABLE\s+${TBL}\s+(?:CONVERT\s+TO\s+CHARACTER\s+SET|ENGINE\s*=)`), code: 'ALTER_TABLE_REBUILD', message: '🟠 BLOCKING: This ALTER requires full table rebuild / 此 ALTER 需要完整重建表', suggestion: 'Use pt-online-schema-change for large tables / 大表建議用 pt-online-schema-change' },
          { pattern: /SELECT\s+[\s\S]*?\s+FOR\s+UPDATE/i, code: 'SELECT_FOR_UPDATE', message: '🟠 BLOCKING: SELECT FOR UPDATE causes exclusive row lock / 會造成排他行鎖', suggestion: 'Confirm if lock is needed, consider optimistic locking / 確認是否真的需要鎖定，考慮使用樂觀鎖' },
          { pattern: /SELECT\s+[\s\S]*?\s+LOCK\s+IN\s+SHARE\s+MODE/i, code: 'LOCK_IN_SHARE_MODE', message: '🟠 BLOCKING: LOCK IN SHARE MODE causes shared row lock / 會造成共享行鎖', suggestion: 'Confirm if shared lock is needed / 確認是否真的需要共享鎖' }
        ],
        bulkOperation: [
          // Evaluated per statement: a DELETE with no WHERE (and no LIMIT)
          // anywhere in that statement — incl. schema-qualified tables and
          // the multi-table `DELETE t FROM t …` form.
          { pattern: /^DELETE\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\s+)*(?:[`\w.]+(?:\s*,\s*[`\w.]+)*\s+)?FROM\s+(?![\s\S]*\bWHERE\b)(?![\s\S]*\bLIMIT\b)/i, code: 'DELETE_ALL', message: '🟠 DATA RISK: DELETE without WHERE will delete all rows / 缺少 WHERE 條件會刪除全表資料', suggestion: 'Add WHERE condition / 請加上 WHERE 條件' },
          // Evaluated per statement: an UPDATE statement with no WHERE (and
          // no LIMIT) of its own. A WHERE in some other statement of the same
          // file no longer hides it, and one in this statement is no longer
          // missed when it's the file's last statement.
          { pattern: /^UPDATE\s+(?:(?:LOW_PRIORITY|IGNORE)\s+)*[\s\S]*?\bSET\b(?![\s\S]*\bWHERE\b)(?![\s\S]*\bLIMIT\b)/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: UPDATE without WHERE will update all rows / 缺少 WHERE 條件會更新全表資料', suggestion: 'Add WHERE condition / 請加上 WHERE 條件' }
        ],
        schemaChange: [
          // COLUMN keyword is optional (ALTER TABLE t DROP nickname), may be one
          // clause of several; DROP INDEX/KEY/FOREIGN KEY/… are separate rules.
          { pattern: re(String.raw`ALTER\s+(?:(?:ONLINE|IGNORE)\s+)*TABLE\s+${TBL}\s+(?:[\s\S]*?,\s*)?DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!(?:INDEX|KEY|PRIMARY|FOREIGN|CONSTRAINT|CHECK|PARTITION|SYSTEM|PERIOD)\b)[\`\w]+`), code: 'DROP_COLUMN', message: '🟠 DATA LOSS: DROP COLUMN will permanently delete column data / 會永久刪除欄位資料', suggestion: 'Confirm column is no longer used / 先確認該欄位已無使用' },
          { pattern: /RENAME\s+TABLE/i, code: 'RENAME_TABLE', message: '🟠 BREAKING: RENAME TABLE may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated table references / 確認所有應用程式都已更新表名引用' },
          { pattern: re(String.raw`ALTER\s+TABLE\s+${TBL}\s+RENAME\s+(?:TO|AS)\b`), code: 'ALTER_RENAME', message: '🟠 BREAKING: RENAME TABLE may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated table references / 確認所有應用程式都已更新表名引用' },
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
          { pattern: re(String.raw`ALTER\s+TABLE\s+${TBL}\s+ADD\s+COLUMN`), message: '⚠️ ALTER TABLE ADD COLUMN may take long on large tables / 在大表上可能需要較長時間' },
          // An added column declared NOT NULL with no DEFAULT anywhere in its
          // definition (DEFAULT may come before or after NOT NULL)
          { pattern: /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:INDEX|KEY|CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|FULLTEXT|SPATIAL|CHECK|PARTITION)\b)[`\w]+\s+(?:(?!\bDEFAULT\b)[^,;])*?\bNOT\s+NULL\b(?:(?!\bDEFAULT\b)[^,;])*(?:,|;|$)/i, message: '⚠️ Adding NOT NULL column should have DEFAULT value / 新增 NOT NULL 欄位建議搭配 DEFAULT 值' },
          { pattern: /AUTO_INCREMENT\s*=/i, message: '⚠️ Manual AUTO_INCREMENT may cause ID conflicts / 手動設定 AUTO_INCREMENT 可能造成 ID 衝突' },
          { pattern: /ENGINE\s*=\s*MyISAM/i, message: '⚠️ MyISAM does not support transactions, use InnoDB / MyISAM 引擎不支援交易，建議使用 InnoDB' },
          { pattern: /CHARSET\s*=\s*(?:latin1|utf8[^m])/i, message: '⚠️ Recommend using utf8mb4 charset / 建議使用 utf8mb4 字元集' },
          { pattern: /\b(?:FLOAT|DOUBLE)\b/i, message: '⚠️ FLOAT/DOUBLE has precision issues, use DECIMAL for money / 有精度問題，金額建議用 DECIMAL' },
          { pattern: /\bDATETIME\b(?!\s*\(\d+\))/i, message: '⚠️ DATETIME without precision truncates microseconds / 沒有指定精度，微秒會被截斷' },
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

  /**
   * Execute migration-authored SQL with a bounded lock-wait guard.
   *
   * Root cause this guards against: MariaDB's metadata lock (MDL) queue is FIFO.
   * If a long-running transaction (e.g. a large batch DELETE) already holds a
   * shared MDL on the target table, an ALTER TABLE requesting an exclusive MDL
   * queues behind it — and because the queue is FIFO, any *new* query on that
   * table (including a plain SELECT) that arrives after the ALTER is already
   * queued gets stuck behind the ALTER too, even though a SELECT would
   * otherwise be lock-compatible. Without a bound, that queue can jam
   * indefinitely.
   *
   * This sets a short `lock_wait_timeout` / `innodb_lock_wait_timeout` on the
   * session before executing, and retries a bounded number of times on
   * MariaDB's lock-wait-timeout error before failing loudly — so a stuck ALTER
   * fails fast instead of parking in the queue and dragging everything else
   * down with it.
   *
   * The migration runs one statement at a time, and a retry re-runs only the
   * statement that timed out. MariaDB commits each DDL statement on its own,
   * so re-running the whole migration would repeat the statements that had
   * already succeeded — a plain CREATE TABLE then fails with "already exists"
   * and the migration is left half-applied with a misleading error. When the
   * script can't be split with certainty (splitSqlStatements() returns null),
   * it's sent as one batch with a single attempt instead — never retried.
   *
   * @param {string} sql - The migration's SQL
   * @param {{database?: string}} [opts] - database to USE first
   * @returns {Promise<*>} - this.connection.query()'s result for the last statement
   */
  async executeWithLockGuard(sql, { database } = {}) {
    const cfg = this.config.ddlSafety?.lockGuard ?? {};
    const enabled = cfg.enabled ?? true;
    const use = database ? `USE \`${database}\`` : null;

    if (!enabled) {
      return this.connection.query(use ? `${use};\n${sql}` : sql);
    }

    const requirePositiveInt = (value, name) => {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`ddlSafety.lockGuard.${name} must be a positive integer, got: ${value}`);
      }
      return value;
    };
    const lockWaitTimeoutSec = requirePositiveInt(cfg.lockWaitTimeoutSec ?? 5, 'lockWaitTimeoutSec');
    const innodbLockWaitTimeoutSec = requirePositiveInt(cfg.innodbLockWaitTimeoutSec ?? 5, 'innodbLockWaitTimeoutSec');
    const maxRetries = cfg.maxRetries ?? 3;
    const retryDelayMs = cfg.retryDelayMs ?? 2000;

    // MariaDB's SET statement doesn't support bound parameters over the
    // prepared-statement (binary) protocol — connection.execute() fails with
    // "Incorrect argument type to variable". Use query() (text protocol) with
    // a value we've already validated as a positive integer.
    await this.connection.query(`SET SESSION lock_wait_timeout = ${lockWaitTimeoutSec}`);
    await this.connection.query(`SET SESSION innodb_lock_wait_timeout = ${innodbLockWaitTimeoutSec}`);
    if (use) await this.connection.query(use);

    const statements = splitSqlStatements(sql);
    if (statements === null) {
      console.warn('⚠️  Lock Guard: this migration could not be split into statements with certainty — running it as one batch, without retries');
      return this.connection.query(sql);
    }

    let result;
    for (const [index, statement] of statements.entries()) {
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          result = await this.connection.query(statement);
          break;
        } catch (error) {
          const isLockWaitTimeout = error && (error.errno === 1205 || error.code === 'ER_LOCK_WAIT_TIMEOUT');
          if (isLockWaitTimeout && attempt < maxRetries) {
            const where = statements.length > 1 ? ` on statement ${index + 1} of ${statements.length}` : '';
            console.warn(`⚠️  Lock wait timeout${where} (attempt ${attempt}/${maxRetries}), retrying that statement in ${retryDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          }
          if (error instanceof Error && statements.length > 1) {
            // Same error object (errno, code kept) — just say where it happened
            // and what had already run, since nothing before it is rolled back.
            const done = index === 0 ? ''
              : index === 1 ? '; statement 1 was already applied'
              : `; statements 1–${index} were already applied`;
            error.message += ` (statement ${index + 1} of ${statements.length}${done}${done ? ' — MariaDB commits each DDL statement, so it is not rolled back' : ''})`;
          }
          throw error;
        }
      }
    }
    return result;
  }

  async connect() {
    try {
      // Support both flat config and nested config.mariadb
      const dbConfig = this.config.mariadb || this.config;
      const dbName = dbConfig.database;
      // Gate R0: fail fast on an unreachable host instead of hanging on the
      // driver's own default, which relies on the OS TCP timeout and can be
      // very long. Applies to every connection attempt below, temp or real.
      const connectTimeout = dbConfig.connectTimeoutMs ?? 10000;

      // No built-in credentials: a missing env var must fail loudly, not
      // silently connect as root with a well-known password.
      if (!dbConfig.user) {
        throw new Error('no user configured — set MARIADB_USER (or `user` in the config).');
      }
      if (dbConfig.password === undefined || dbConfig.password === null) {
        throw new Error(`no password configured for user '${dbConfig.user}' — set MARIADB_PASSWORD (or \`password\` in the config; use '' explicitly for an account without one).`);
      }
      const connectionOptions = {
        host: dbConfig.host || 'localhost',
        port: dbConfig.port || 3306,
        user: dbConfig.user,
        password: dbConfig.password,
        multipleStatements: true,
        connectTimeout
      };
      const ssl = resolveSslOption(dbConfig.ssl);
      if (ssl) connectionOptions.ssl = ssl;

      // 🔧 First connect without specifying database to avoid "unknown database" error
      const tempConnection = await mysql.createConnection(connectionOptions);

      if (dbName) {
        // Gate R0: a database that doesn't exist almost always means the
        // config/env points at the wrong server or has a typo. Creating it
        // would quietly apply every migration to a brand-new empty database,
        // so that only happens when explicitly enabled (new environments,
        // local/test setups).
        const [existing] = await tempConnection.execute(
          'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName]
        );
        if (existing.length === 0) {
          if (this.readOnly) {
            await tempConnection.end();
            throw new Error(
              `database '${dbName}' does not exist on ${connectionOptions.host}:${connectionOptions.port}` +
              (this.config.createDatabaseIfMissing ? ' yet — a writing run would create it (createDatabaseIfMissing: true); read-only commands never do.' : '. Check the host and database name.')
            );
          }
          if (!this.config.createDatabaseIfMissing) {
            await tempConnection.end();
            throw new Error(
              `database '${dbName}' does not exist on ${connectionOptions.host}:${connectionOptions.port}. ` +
              'Check the host and database name. If this is a new environment and it should be created, ' +
              'set createDatabaseIfMissing: true in the config.'
            );
          }
          await tempConnection.execute(
            `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
             DEFAULT CHARACTER SET utf8mb4
             DEFAULT COLLATE utf8mb4_unicode_ci`
          );
          console.log(`  🆕 Created database '${dbName}' (createDatabaseIfMissing: true)`);
        }
        await tempConnection.end();

        // Now connect to the specified database
        this.connection = await mysql.createConnection({ ...connectionOptions, database: dbName });
      } else {
        this.connection = tempConnection;
      }

      // Gate R0: identity check — confirm the connection actually points at
      // the database config says it should, before anything else touches it.
      // Defense-in-depth against a resolved-wrong-environment env var or a
      // connection-reuse bug, not just a redundant re-check of the option we
      // just passed to createConnection() above — see docs/RUNTIME-GATE-PLAN.md.
      if (dbName) {
        const [[identityRow]] = await this.connection.execute('SELECT DATABASE() AS db');
        if (identityRow.db !== dbName) {
          await this.connection.end();
          this.connection = null;
          throw new Error(
            `Connected to the wrong database — expected '${dbName}' but the connection reports '${identityRow.db}'. ` +
            `This usually means an environment variable resolved to the wrong host/database. Refusing to proceed.`
          );
        }
      }

      // The tool's own statements (changelog bookkeeping, checks) must never
      // wait indefinitely on a lock either — same bound as the Lock Guard
      // (MariaDB's default lock_wait_timeout is a year).
      const guard = this.config.ddlSafety?.lockGuard ?? {};
      if (guard.enabled ?? true) {
        const wait = Number.isInteger(guard.lockWaitTimeoutSec) && guard.lockWaitTimeoutSec > 0 ? guard.lockWaitTimeoutSec : 5;
        await this.connection.query(`SET SESSION lock_wait_timeout = ${wait}`);
      }

      // Ensure changelog table exists (DDL/versioned mode only;
      // DCL/repeatable mode uses checksumTable, not changelogTable)
      // Skipped for read-only commands (status, up --dry-run): they must work
      // with a SELECT-only account and leave the database untouched.
      if (this.config.mode !== 'repeatable' && !this.readOnly) {
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

  /** Column names of the changelog table, or null when it doesn't exist (read-only lookup). */
  async changelogColumns() {
    const [rows] = await this.connection.execute(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [this.changelogTable]
    );
    return rows.length ? new Set(rows.map(r => String(r.name).toLowerCase())) : null;
  }

  async ensureChangelogTable() {
    const dbConfig = this.config.mariadb || this.config;
    const dbName = dbConfig.database;

    // Re-create the database if a DOWN migration dropped it (e.g. a
    // create-database migration rolled back) — but only when it's really
    // gone, and only if createDatabaseIfMissing allows it. Never run
    // CREATE DATABASE IF NOT EXISTS against an existing database: it still
    // requests an exclusive lock on the schema, so with a long transaction
    // open it queues — and everything else in the schema queues behind it.
    if (dbName) {
      const [existing] = await this.connection.execute(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dbName]
      );
      if (existing.length === 0) {
        if (!this.config.createDatabaseIfMissing) {
          throw new Error(`database '${dbName}' no longer exists (a Down section may have dropped it). Set createDatabaseIfMissing: true to let the tool recreate it.`);
        }
        await this.connection.execute(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`
        );
      }
      await this.connection.query(`USE \`${dbName}\``);
    }

    // Use fully qualified table name so this works regardless of connection context
    const qualifiedTable = dbName ? `\`${dbName}\`.${this.changelogTable}` : this.changelogTable;
    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64) NULL
      )
    `);
    // Self-heal for changelog tables created before checksum tracking existed —
    // CREATE TABLE IF NOT EXISTS above is a no-op against them, so the column
    // needs adding explicitly (a cheap lookup once it's there; MySQL-safe).
    await addColumnIfMissing(this.connection, {
      table: qualifiedTable, tableName: this.changelogTable, schema: dbName || null,
      column: 'checksum', definition: 'VARCHAR(64) NULL'
    });
  }

  /**
   * SHA-256 checksum of a migration file's raw content — same algorithm
   * RepeatableRunner uses for DCL, applied here to DDL so an already-applied
   * migration file being edited afterward is detectable instead of silently
   * invisible (see docs/DDL-PRODUCTION-SAFETY.md).
   */
  calculateChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Explicitly accept a migration file's current on-disk content as the new
   * checksum baseline — used by `--allow-checksum-drift` after a human has
   * confirmed an already-applied file's post-hoc edit was intentional. Not
   * used for the automatic first-time backfill in status() (that path has
   * no prior checksum to have drifted from; this one overwrites one that did).
   */
  async repairChecksum(fileName) {
    const content = await fs.readFile(path.join(this.config.migrationsDir, fileName), 'utf-8');
    const checksum = this.calculateChecksum(content);
    await this.connection.execute(
      `UPDATE ${this.changelogTable} SET checksum = ? WHERE id = ?`,
      [checksum, fileName.replace('.sql', '')]
    );
    return checksum;
  }

  async status() {
    try {
      // DCL/repeatable mode does not use the DDL changelog table (schema_migrations).
      // Calling adapter.status() in DCL mode would create schema_migrations and then
      // query it. Return empty DDL status instead — use `dcl:status` for DCL migration status.
      if (this.config.mode === 'repeatable') {
        return { pending: [], applied: [], total: 0 };
      }

      // Get applied migrations from changelog
      // applied_at read as a Unix epoch: the driver would otherwise
      // interpret the server-session-time-zone value as *local* time and be
      // off by the zone difference (e.g. 8h for a UTC server read in UTC+8).
      let rawRows = [];
      if (this.readOnly) {
        // Read-only: never create or alter the changelog. A missing table
        // just means nothing has been applied yet.
        const columns = await this.changelogColumns();
        if (columns) {
          const checksumCol = columns.has('checksum') ? 'checksum' : 'NULL AS checksum';
          [rawRows] = await this.connection.execute(
            `SELECT id, applied_at, UNIX_TIMESTAMP(applied_at) AS applied_epoch, ${checksumCol} FROM ${this.changelogTable} ORDER BY applied_at`
          );
        }
      } else {
        // Ensure DB + changelog table exist (may have been dropped by a DOWN migration)
        await this.ensureChangelogTable();
        [rawRows] = await this.connection.execute(
          `SELECT id, applied_at, UNIX_TIMESTAMP(applied_at) AS applied_epoch, checksum FROM ${this.changelogTable} ORDER BY applied_at`
        );
      }
      const rows = rawRows.map(r => ({
        ...r,
        applied_at: r.applied_epoch != null ? new Date(Number(r.applied_epoch) * 1000) : r.applied_at
      }));
      const appliedById = new Map(rows.map(r => [r.id, r]));

      // Get all migration files (R__ files excluded — see isRepeatableMigrationFile())
      const migrationsDir = this.config.migrationsDir;
      const migrationFiles = await this.getMigrationFiles();

      // Gate R1 (remaining checks): a changelog row with no file on disk to
      // back it means the file was deleted/renamed after being applied
      // (down() can never run it again) or the changelog points at the
      // wrong migrationsDir entirely — flag it rather than silently
      // ignoring it. Set-membership only, so a rename shows up as one
      // orphaned entry, not as a false "modified" anything.
      const fileIds = new Set(migrationFiles.map(f => f.replace('.sql', '')));
      const orphanedChangelogEntries = rows
        .filter(r => !fileIds.has(r.id) && !isRepeatableMigrationFile(r.id))
        .map(r => ({ id: r.id, appliedAt: r.applied_at }));
      // R__ rows: an R__ file with an Up section in a DDL directory used to be
      // run as a versioned migration. Reported, not treated as orphaned.
      const ignoredRepeatableEntries = rows.filter(r => !fileIds.has(r.id) && isRepeatableMigrationFile(r.id)).map(r => r.id);

      const pending = [];
      const applied = [];
      const checksumMismatches = [];
      const checksumBaselined = [];
      // Gate R1 (remaining checks): applied migrations should form a
      // contiguous prefix of the sorted file list. Once we've seen a
      // pending (not-yet-applied) file, any LATER file (in sort order) that
      // IS applied means migrations ran out of order or a file was renamed
      // after being applied — both signs the changelog's ordering
      // assumptions no longer hold.
      const outOfOrderApplied = [];
      let seenPending = false;

      for (const file of migrationFiles) {
        const id = file.replace('.sql', '');
        const row = appliedById.get(id);
        if (row) {
          // Compare the currently-on-disk content's checksum against what was
          // recorded at apply time, so a migration file edited AFTER being
          // applied is detectable instead of silently invisible.
          let currentChecksum = null;
          try {
            const content = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
            currentChecksum = this.calculateChecksum(content);
          } catch {
            // File unreadable (permissions, race) — skip the checksum check
            // for this entry rather than fail status() entirely.
          }

          if (currentChecksum) {
            if (row.checksum == null && this.readOnly) {
              // Would be baselined by a writing command; read-only leaves it.
            } else if (row.checksum == null) {
              // Row predates checksum tracking (upgraded from an older version
              // of this tool). There's no historical checksum to compare
              // against, so adopt the current on-disk content as the trusted
              // baseline going forward — same as Flyway's behavior when
              // checksum validation is enabled after migrations already ran.
              await this.connection.execute(
                `UPDATE ${this.changelogTable} SET checksum = ? WHERE id = ?`,
                [currentChecksum, id]
              );
              checksumBaselined.push(file);
            } else if (row.checksum !== currentChecksum) {
              checksumMismatches.push({ fileName: file, appliedAt: row.applied_at });
            }
          }

          if (seenPending) {
            outOfOrderApplied.push(file);
          }

          applied.push({
            fileName: file,
            appliedAt: row.applied_at
          });
        } else {
          pending.push(file);
          seenPending = true;
        }
      }

      return {
        pending,
        applied,
        total: migrationFiles.length,
        checksumMismatches,
        checksumBaselined,
        orphanedChangelogEntries,
        outOfOrderApplied,
        ignoredRepeatableEntries,
        ignoredRepeatableFiles: await this.getIgnoredRepeatableFiles()
      };
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  /**
   * Get list of migration files
   */
  async getMigrationFiles() {
    const files = await fs.readdir(this.config.migrationsDir);
    return files.filter(f => f.endsWith('.sql') && !isRepeatableMigrationFile(f)).sort();
  }

  /** R__ files sitting in this versioned directory, which status/up/validate ignore. */
  async getIgnoredRepeatableFiles() {
    if (this.config.mode === 'repeatable') return [];
    const files = await fs.readdir(this.config.migrationsDir);
    return files.filter(f => f.endsWith('.sql') && isRepeatableMigrationFile(f)).sort();
  }

  /**
   * True when the file has a `-- +migrate <section>` marker at all — unlike
   * extractSection(), which can't tell "no marker" from "empty section".
   */
  hasSection(content, section) {
    return new RegExp(`--\\s*\\+migrate\\s+${section}\\b`, 'i').test(content);
  }

  /** Why a versioned file without an Up marker is rejected — it would never run. */
  missingUpMarkerMessage() {
    return 'no "-- +migrate Up" section. Nothing in this file would run and it would stay pending forever — ' +
      'put the migration SQL under "-- +migrate Up" (and its rollback under "-- +migrate Down").';
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
          // Baseline establishes the trust baseline itself — store the
          // current file's checksum so future edits to it are still detected,
          // even though the SQL was never actually executed here.
          const content = await fs.readFile(path.join(this.config.migrationsDir, file), 'utf-8');
          const checksum = this.calculateChecksum(content);
          await this.connection.execute(
            `INSERT INTO ${this.changelogTable} (id, checksum) VALUES (?, ?)`,
            [id, checksum]
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

  /**
   * Delete all rows from a changelog/checksum table. Does NOT run down() and does
   * NOT touch any actual schema or data — this only clears the tool's own tracking
   * records, so the next `status`/`up`/`dcl` treats every migration as pending again.
   *
   * Used for both DDL (changelog table, `tableName` omitted → uses `this.changelogTable`)
   * and DCL (checksum table, caller passes the already-validated `tableName`).
   *
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] - Count only, don't delete
   * @param {string}  [options.tableName] - Override table (used for DCL checksum tables)
   * @returns {Promise<number>} Number of rows that existed before deletion
   */
  async resetChangelog({ dryRun = false, tableName } = {}) {
    const table = tableName || this.changelogTable;
    // Same identifier rule as RepeatableRunner's checksumTable validation — this is
    // interpolated directly into SQL below, so it must be a safe bare identifier.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table)) {
      throw new Error(`Invalid table name: ${table}. Must be a valid identifier (letters, digits, underscores).`);
    }

    const dbConfig = this.config.mariadb || this.config;
    const dbName = dbConfig.database;
    const qualifiedTable = dbName ? `\`${dbName}\`.${table}` : table;

    try {
      const [[{ cnt }]] = await this.connection.query(`SELECT COUNT(*) AS cnt FROM ${qualifiedTable}`);
      const count = Number(cnt);
      if (!dryRun && count > 0) {
        await this.connection.query(`DELETE FROM ${qualifiedTable}`);
      }
      return count;
    } catch (error) {
      // Table doesn't exist yet — nothing to reset
      if (error.code === 'ER_NO_SUCH_TABLE') return 0;
      throw error;
    }
  }

  /** All rule codes this adapter reports (for checking validation.rules). */
  knownValidationCodes() {
    const codes = new Set(['SQL_SYNTAX_ERROR', 'SQL_SYNTAX_ERROR_DOWN', 'SANITY_SQL_SYNTAX_ERROR', 'ORPHAN_DROP_DOWN', 'ORPHAN_DROP_UP', 'FK_REFERENCES_DROPPED_TABLE', 'FK_UNRESOLVED_REFERENCE', 'MISSING_DOWN', 'MISSING_UP_MARKER', 'INSERT_SELECT', 'DROP_TABLE']);
    for (const mode of ['versioned', 'repeatable']) {
      const rules = this.getValidationRules(mode);
      for (const group of [rules.forbidden, rules.dangerous]) {
        for (const list of Object.values(group)) for (const r of list) codes.add(r.code);
      }
    }
    return codes;
  }

  /** DDL inside a DCL project stays unbypassable, whatever config says. */
  protectedValidationCodes() {
    return (this.getValidationRules('repeatable').forbidden.dclReverse || []).map(r => r.code);
  }

  /**
   * Pre-execution runtime gates R2–R4 (docs/RUNTIME-GATE-PLAN.md). Read-only
   * queries; each check that can't run (missing privilege, binlog off) is
   * reported as skipped rather than failing the run.
   *
   *   R2 openTransactions / metadataLockWaits — transactions in this database
   *      open longer than longTransactionSec, and sessions already queued on
   *      a metadata lock: an ALTER now would queue behind them and jam every
   *      later query on the table (the 2026-09-10 incident)
   *   R3 readOnly — @@read_only / @@innodb_read_only. Checked regardless of
   *      the account's privileges: a SUPER/READ_ONLY ADMIN account can still
   *      write to a read-only replica, which only makes it diverge
   *   R4 warnings — total binary log size above binlogWarnMb
   *
   * @param {{ locks?: boolean, disk?: boolean }} [which] - R2 / R4 (R3 always)
   */
  async runtimePreflight({ locks = true, disk = true } = {}) {
    const cfg = this.getRuntimeGateConfig();
    const dbName = (this.config.mariadb || this.config).database;
    const out = { openTransactions: [], metadataLockWaits: [], readOnly: null, warnings: [], skipped: [] };

    const [[ro]] = await this.connection.query('SELECT @@global.read_only AS ro, @@global.innodb_read_only AS iro');
    if (Number(ro.ro) === 1 || Number(ro.iro) === 1) {
      out.readOnly = { reason: Number(ro.iro) === 1 ? 'innodb_read_only = ON' : 'read_only = ON' };
    }

    if (locks) {
      try {
        const [trx] = await this.connection.query(
          `SELECT t.trx_mysql_thread_id AS thread_id, TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS duration_sec,
                  p.USER AS user, p.HOST AS host, LEFT(COALESCE(t.trx_query, p.INFO, ''), 200) AS query
             FROM information_schema.INNODB_TRX t
             LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
            WHERE TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) > ?
              AND t.trx_mysql_thread_id <> CONNECTION_ID()
              AND (p.DB = ? OR p.DB IS NULL)
            ORDER BY duration_sec DESC`,
          [cfg.longTransactionSec, dbName]
        );
        out.openTransactions = trx.map(r => ({ id: `thread ${r.thread_id}`, durationSec: Number(r.duration_sec), who: `${r.user ?? '?'}@${r.host ?? '?'}`, query: r.query || '(idle in transaction)' }));
        const [waits] = await this.connection.query(
          `SELECT ID AS id, USER AS user, HOST AS host, TIME AS time_sec, STATE AS state, LEFT(COALESCE(INFO, ''), 200) AS query
             FROM information_schema.PROCESSLIST
            WHERE (STATE LIKE '%metadata lock%' OR STATE LIKE 'Waiting for table%') AND DB = ? AND ID <> CONNECTION_ID()`,
          [dbName]
        );
        out.metadataLockWaits = waits.map(r => ({ id: `thread ${r.id}`, durationSec: Number(r.time_sec), who: `${r.user}@${r.host}`, state: r.state, query: r.query }));
      } catch (error) {
        out.skipped.push(`R2 open-transaction check (needs the PROCESS privilege): ${error.message}`);
      }
    }

    if (disk) {
      try {
        const [logs] = await this.connection.query('SHOW BINARY LOGS');
        const totalMb = logs.reduce((sum, l) => sum + Number(l.File_size || 0), 0) / 1024 / 1024;
        if (totalMb > cfg.binlogWarnMb) {
          out.warnings.push(`Binary logs total ${Math.round(totalMb)} MB (over ${cfg.binlogWarnMb} MB) — a large ALTER adds to that; check the server's disk headroom first`);
        }
      } catch (error) {
        out.skipped.push(/not using binary logging/i.test(error.message)
          ? 'R4 binary-log size: binary logging is off'
          : `R4 binary-log size (needs BINLOG MONITOR / REPLICATION CLIENT): ${error.message}`);
      }
    }
    return out;
  }

  /**
   * Snapshot the real, current schema — one entry per table with its columns.
   * Used by the `sync` CLI command to show what the database actually looks like
   * after applying migrations, rather than trusting the migration files alone.
   *
   * @returns {Promise<{table: string, engine: string, rows: number, columns: {name: string, type: string, nullable: boolean, key: string, default: string|null}[]}[]>}
   */
  async getSchemaSnapshot() {
    const dbConfig = this.config.mariadb || this.config;
    const dbName = dbConfig.database;

    const [tables] = await this.connection.query(
      `SELECT TABLE_NAME, ENGINE, TABLE_ROWS
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [dbName]
    );

    const snapshot = [];
    for (const t of tables) {
      const [columns] = await this.connection.query(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [dbName, t.TABLE_NAME]
      );
      snapshot.push({
        table: t.TABLE_NAME,
        engine: t.ENGINE,
        rows: t.TABLE_ROWS === null ? null : Number(t.TABLE_ROWS),
        columns: columns.map(c => ({
          name: c.COLUMN_NAME,
          type: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          key: c.COLUMN_KEY || '',
          default: c.COLUMN_DEFAULT
        }))
      });
    }
    return snapshot;
  }

  async up(options = {}) {
    const result = {
      applied: [],
      errors: []
    };

    try {
      const status = await this.status();
      const { selected: pendingMigrations, error: selectError } = selectPendingMigrations(status.pending, options);
      if (selectError) {
        result.errors.push(selectError);
        return result;
      }
      
      const dbConfig = this.config.mariadb || this.config;
      const dbName = dbConfig.database;

      for (const file of pendingMigrations) {
        try {
          const filePath = path.join(this.config.migrationsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          if (!this.hasSection(content, 'Up')) {
            throw new Error(this.missingUpMarkerMessage());
          }
          // Extract UP section
          const upSQL = this.extractSection(content, 'Up');
          
          if (upSQL) {
            // Prepend USE <db> directly into the SQL so the correct database
            // context is guaranteed within the same multi-statement execution.
            // This means migration files don't need to include "USE <db>" themselves.
            // Run in the configured database, guarded against MDL queue jams
            await this.executeWithLockGuard(upSQL, { database: dbName });
          }

          // Record in changelog — an Up section with no statements is a
          // deliberate no-op migration and is recorded as applied too.
          const id = file.replace('.sql', '');
          await this.connection.execute(
            `INSERT INTO ${this.changelogTable} (id, checksum) VALUES (?, ?)`,
            [id, this.calculateChecksum(content)]
          );

          result.applied.push(file);
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
      const { selected, error: selectError } = selectPendingMigrations(status.pending, options);
      if (selectError) {
        result.errors.push(selectError);
        return result;
      }
      
      for (const file of selected) {
        try {
          const filePath = path.join(this.config.migrationsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          if (!this.hasSection(content, 'Up')) {
            throw new Error(this.missingUpMarkerMessage());
          }
          
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
                  await this.executeWithLockGuard(upSQL, { database: dbName });
                }
                const id = file.replace('.sql', '');
                await this.connection.execute(
                  `INSERT INTO ${this.changelogTable} (id, checksum) VALUES (?, ?)`,
                  [id, this.calculateChecksum(content)]
                );
              },
              down: async () => {
                if (downSQL) {
                  const dbName = (this.config.mariadb || this.config).database;
                  await this.executeWithLockGuard(downSQL, { database: dbName });
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
              // Stop either way: even when auto-rollback undid this one,
              // later migrations may depend on it (same rule as up()).
              result.errors.push(`${file}: ${sanityResult.error}`);
              break;
            }
          } else {
            // No sanity checks, run normally (same behaviour as up())
            {
              console.log(`\n🔍 Running ${file} (no sanity checks)...`);
              const startTime = Date.now();
              if (upSQL) {
                const dbName = (this.config.mariadb || this.config).database;
                await this.executeWithLockGuard(upSQL, { database: dbName });
              }
              const id = file.replace('.sql', '');
              await this.connection.execute(
                `INSERT INTO ${this.changelogTable} (id, checksum) VALUES (?, ?)`,
                [id, this.calculateChecksum(content)]
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

  /**
   * What `down` would roll back, most recent first: the last `count` applied
   * migrations, or — with `target` — everything applied after it and the
   * target itself. Also returns which of those files were edited since being
   * applied (their Down section may not be the one that was reviewed).
   * @returns {Promise<{files: string[], error: string|null, checksumMismatches: string[]}>}
   */
  async rollbackPlan({ count = 1, target } = {}) {
    const status = await this.status();
    const newestFirst = status.applied.map(a => a.fileName).reverse();
    const { selected, error } = target
      ? selectPendingMigrations(newestFirst, { target })
      : { selected: newestFirst.slice(0, count), error: null };
    const planned = new Set(selected);
    return {
      files: selected,
      error,
      checksumMismatches: (status.checksumMismatches || []).map(m => m.fileName).filter(f => planned.has(f))
    };
  }

  /**
   * @param {number|string[]} countOrFiles - how many to roll back, or the
   *   exact files from rollbackPlan() (most recent first)
   */
  async down(countOrFiles = 1) {
    const result = {
      rolledBack: [],
      errors: []
    };

    try {
      const files = Array.isArray(countOrFiles)
        ? countOrFiles
        : (await this.rollbackPlan({ count: countOrFiles })).files;
      
      for (const fileName of files) {
        const migration = { fileName };
        try {
          const filePath = path.join(this.config.migrationsDir, migration.fileName);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Extract DOWN section
          const downSQL = this.extractSection(content, 'Down');
          if (!downSQL) {
            throw new Error('no "-- +migrate Down" section (or it is empty) — nothing to roll back with, so it was left applied');
          }
          
          {
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
              // Run in the configured database, guarded against MDL queue jams
              await this.executeWithLockGuard(downSQL, { database: dbConfigDown.database });
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
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] - which of a multi-directory migrationsDir to create it in (see pickDir())
   */
  async createDCL(name, sequenceNumber = '', { dir } = {}) {
    // Generate filename: R__001_name.sql or R__name.sql
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const prefix = sequenceNumber ? `R__${sequenceNumber}_` : 'R__';
    const fileName = `${prefix}${sanitizedName}.sql`;
    const filePath = path.join(pickDir(this.config.migrationsDir, dir), fileName);

    // Already there — in this directory or, with several, in any of them
    // (the same name in two directories is rejected when DCL runs)
    const existingIn = await findExisting(this.config.migrationsDir, fileName);
    if (existingIn) throw new Error(`DCL migration file already exists: ${path.join(existingIn, fileName)}`);

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
      // Same file set and order status()/up() use, so the cross-file FK
      // check below sees files in the order they actually run. In a
      // versioned project R__ (DCL) files are ignored and reported.
      // DCL may list several directories (see core/migration-dirs.js).
      const repeatableFiles = this.config.mode === 'repeatable'
        ? await listMigrationFiles(migrationsDir, f => f.endsWith('.sql'))
        : null;
      const migrationFiles = repeatableFiles
        ? repeatableFiles.map(f => f.fileName)
        : await this.getMigrationFiles();
      const filePathOf = new Map((repeatableFiles || []).map(f => [f.fileName, f.filePath]));
      results.ignoredRepeatableFiles = await this.getIgnoredRepeatableFiles();
      // options.files: report only these (e.g. the pending ones). Every file
      // is still read, so the cross-file FK check knows what earlier
      // migrations created.
      const wanted = options.files ? new Set(options.files) : null;
      if (wanted) results.skippedFiles = migrationFiles.filter(f => !wanted.has(f));

      const filesData = [];
      for (const file of migrationFiles) {
        filesData.push({ fileName: file, content: await fs.readFile(filePathOf.get(file) || path.join(migrationsDir, file), 'utf-8') });
      }
      results.configWarnings = this.checkValidationConfig(migrationFiles);

      // Tables that exist before each file runs (earlier files + config),
      // so a DROP TABLE can be told apart from a typo (DDL mode only).
      const knownTablesBefore = this.config.mode === 'repeatable' ? null : this.tablesBeforeEachFile(filesData);

      for (const [i, { fileName: file, content }] of filesData.entries()) {
        if (wanted && !wanted.has(file)) continue;

        const fileResult = this.validateContent(content, file, {
          ...options,
          ...(knownTablesBefore ? { knownTables: knownTablesBefore[i] } : {})
        });

        results.results.push({
          file,
          ...fileResult
        });

        if (!fileResult.valid) {
          results.valid = false;
        }
      }

      // Cross-file FK dependency check (DDL mode only; repeatable returns [])
      const crossFKResults = this.validateCrossFileFKDependencies(filesData, options);
      for (const { fileName, errors: fkErrors, warnings: fkWarnings } of crossFKResults) {
        const fileResult = results.results.find(r => r.file === fileName);
        if (fileResult) {
          if (fkWarnings && fkWarnings.length > 0) {
            fileResult.warnings.push(...fkWarnings);
          }
          if (fkErrors.length > 0) {
            fileResult.errors.push(...fkErrors);
            fileResult.summary.structural += fkErrors.length;
            fileResult.valid = false;
            results.valid = false;
          }
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
  parseFileAnnotations(content, _fileName) {
    const annotations = {
      allowDangerous: false,
      allowForbidden: false,
      allowedCodes: [],
      approvedBy: null
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
      const approvedMatch = t.match(/--\s*@approved-by\s*:\s*(.+)/i);
      if (approvedMatch && approvedMatch[1].trim()) annotations.approvedBy = approvedMatch[1].trim();
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
  validateSQLSyntax(content, _fileName) {
    const errors = [];
    const warnings = [];

    // Allow opt-out via annotation
    if (/--\s*@skip-syntax-check\s*:\s*true/i.test(content)) {
      warnings.push({ type: 'syntax-check-skipped', message: '⚠️ SQL syntax check skipped (@skip-syntax-check: true)' });
      return { errors, warnings };
    }

    // Helper: clean unicode noise from SQL before parsing
    const cleanUnicode = (sql) => sql
      // eslint-disable-next-line no-misleading-character-class -- distinct zero-width codepoints to strip, not a joined sequence
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .trim();

    // Helper: parse SQL with node-sql-parser; push error if syntax invalid
    // Pre-process SQL to backtick-quote identifiers that appear immediately before
    // a column type keyword. node-sql-parser incorrectly treats several valid MariaDB
    // column names (e.g. status, type, end, session, global) as reserved keywords,
    // causing false-positive syntax errors. Wrapping them in backticks makes the
    // parser treat them as identifiers without changing runtime semantics.
    const SQL_TYPES = 'INT|TINYINT|SMALLINT|MEDIUMINT|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|BIT|BOOLEAN|BOOL|SERIAL|CHAR|VARCHAR|NCHAR|NVARCHAR|BINARY|VARBINARY|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|DATE|TIME|DATETIME|TIMESTAMP|YEAR|JSON|POINT|GEOMETRY';
    const quoteReservedIdentifiers = (sql) =>
      sql.replace(
        new RegExp(`(?<!['\`\\w])\\b([a-z_][a-z0-9_]*)\\b(?=\\s+(?:${SQL_TYPES})(?:[\\s,(]|$))`, 'gi'),
        (match, ident) => `\`${ident}\``
      );

    // ALTER TABLE ... ADD [CONSTRAINT name] FOREIGN KEY — node-sql-parser only
    // supports foreign keys declared inline inside CREATE TABLE; the ALTER-TABLE
    // form (used to add/re-add a constraint after the table already exists) hits
    // its ALTER grammar and fails to parse even though it's valid MariaDB SQL.
    const hasAlterAddForeignKey = (sql) =>
      /\bALTER\s+TABLE\b[\s\S]*?\bADD\b(?:\s+CONSTRAINT\s+[`\w]+)?\s+FOREIGN\s+KEY\b/i.test(sql);

    // Known column names node-sql-parser's MariaDB grammar misparses as reserved
    // words outside of a CREATE TABLE column-type context — e.g. in an INSERT
    // column list. Backtick-quote them there too so the parser treats them as
    // plain identifiers.
    const INSERT_COLUMN_RESERVED_WORDS = ['status', 'type', 'end', 'session', 'global'];
    const quoteReservedInInsertColumnList = (sql) =>
      sql.replace(/(\bINSERT\s+INTO\s+[`\w.]+\s*)\(([^)]*)\)/gi, (match, prefix, cols) => {
        const quotedCols = cols.split(',').map(col => {
          const trimmed = col.trim();
          const bare = trimmed.replace(/^`|`$/g, '');
          return INSERT_COLUMN_RESERVED_WORDS.includes(bare.toLowerCase()) ? `\`${bare}\`` : trimmed;
        }).join(', ');
        return `${prefix}(${quotedCols})`;
      });

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
      if (hasAlterAddForeignKey(clean)) {
        warnings.push({
          type: 'syntax-check-skipped',
          message: `⚠️ SQL syntax check skipped (${label}): ALTER TABLE ADD FOREIGN KEY detected (not supported by parser)`
        });
        return;
      }
      const normalized = quoteReservedInInsertColumnList(quoteReservedIdentifiers(clean));
      try {
        const parser = new SQLParser();
        parser.astify(normalized, { database: 'MariaDB' });
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

      // Collect SQL statements from the sanity section, the same way
      // executeSanityCheck() runs them:
      // - Directive: -- EXPECT_ROWS: <sql> / -- EXPECT_NO_ROWS: <sql> — one
      //   statement each (they have no ';' between them, so they must not be
      //   joined with the raw lines and re-split)
      // - Raw: bare SQL split by ';'
      const statements = [];
      const rawBuf = [];
      for (const line of sanityBody.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const expectMatch = trimmed.match(/^--\s*EXPECT_(?:NO_)?ROWS:\s*(.+)$/i);
        if (expectMatch) {
          statements.push(expectMatch[1].trim().replace(/;$/, ''));
          continue;
        }
        // Skip pure comments
        if (/^--/.test(trimmed)) continue;
        // Raw SQL line
        rawBuf.push(line);
      }
      statements.push(...rawBuf.join('\n').split(';').map(s => s.trim()).filter(s => s.length > 0));

      if (statements.length === 0) continue;

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
      allowedCodes: [
        ...(options.allowedCodes || []),
        ...(fileAnnotations.allowedCodes || []),
        ...(this.getValidationConfig().allow[fileName] || [])
      ]
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
    const createdTablesInDown = this.extractCreatedTables(downSQL);
    const droppedTablesInDown = this.extractDroppedTables(downSQL);
    const droppedTablesInUp = this.extractDroppedTables(upSQL);
    
    // === 1b. Extract created and dropped databases ===
    const hasCreateDatabaseInUp = /CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.test(normalizedUpSQL);
    const hasDropDatabaseInDown = /DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?/i.test(normalizedDownSQL);
    const hasDropDatabaseInUp = /DROP\s+DATABASE\s+(?:IF\s+EXISTS\s+)?/i.test(normalizedUpSQL);

    // === 2. DDL only: Check for orphan drops in DOWN section (R__ repeatable files have no UP/DOWN) ===
    // A table this migration didn't create being dropped is only a FALSE
    // POSITIVE away from a completely normal pattern — table X created by an
    // earlier migration, removed by a later one — because this check only
    // sees one file at a time (no cross-file/changelog history is available
    // here). So unlike a real forbidden op, it's allowable the same way a
    // dangerous op is: --allow-dangerous, or the specific code via
    // --allow/@allow.
    if (this.config.mode !== 'repeatable') {
      const isOrphanDropAllowed = (code) =>
        options.allowDangerous || (options.allowedCodes && options.allowedCodes.includes(code));

      for (const dropped of droppedTablesInDown) {
        if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
          if (isOrphanDropAllowed('ORPHAN_DROP_DOWN')) {
            warnings.push({
              type: 'orphan-drop-allowed',
              code: 'ORPHAN_DROP_DOWN',
              message: `⚠️ [ALLOWED] Orphan drop: DOWN drops '${dropped}' but UP doesn't create it — assumed created by an earlier migration`
            });
          } else {
            errors.push({
              type: 'orphan-drop',
              code: 'ORPHAN_DROP_DOWN',
              message: `Orphan drop: DOWN drops '${dropped}' but UP doesn't create it`
            });
          }
        }
      }

      // === 2b. Check for orphan drops in UP section ===
      for (const dropped of droppedTablesInUp) {
        if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
          const droppedLower = dropped.toLowerCase();
          // Smart allowance, same pattern as CREATE/DROP DATABASE below: if DOWN
          // recreates exactly what UP dropped, this is a genuine, self-contained
          // reverse migration for a table an earlier file created — no flag needed,
          // same way DROP TABLE in a DOWN section is auto-allowed when UP created it.
          if (createdTablesInDown.map(t => t.toLowerCase()).includes(droppedLower)) {
            warnings.push({
              type: 'orphan-drop-in-up-allowed',
              code: 'ORPHAN_DROP_UP',
              message: `✅ [ALLOWED] Orphan drop in UP: '${dropped}' is dropped but not created in this migration — allowed because DOWN recreates it`
            });
          } else if (options.knownTables && options.knownTables.has(droppedLower)) {
            // validate() knows every earlier file: this table really exists
            // (an earlier migration created it, or validation.existingTables
            // says so), so this drops real data — a dangerous op needing
            // explicit approval, not a likely typo.
            const source = options.knownTables.get(droppedLower);
            const message = `🟠 DATA LOSS: DROP TABLE '${dropped}' (${source}) permanently deletes its data, and DOWN doesn't recreate it / 會永久刪除資料表與資料`;
            const suggestion = 'Confirm nothing reads this table any more and a backup exists; approve with -- @allow: DROP_TABLE';
            if (options.allowDangerous || options.allowedCodes?.includes('DROP_TABLE')) {
              warnings.push({ type: 'dangerous-allowed', code: 'DROP_TABLE', message: `✅ [ALLOWED] ${message}`, suggestion });
            } else {
              dangerousOps.push({ type: 'dangerous-dataLoss', code: 'DROP_TABLE', message, suggestion });
            }
          } else if (isOrphanDropAllowed('ORPHAN_DROP_UP')) {
            warnings.push({
              type: 'orphan-drop-in-up-allowed',
              code: 'ORPHAN_DROP_UP',
              message: `⚠️ [ALLOWED] Orphan drop in UP: '${dropped}' is dropped but not created in this migration — assumed created by an earlier migration`
            });
          } else {
            errors.push({
              type: 'orphan-drop-in-up',
              code: 'ORPHAN_DROP_UP',
              message: options.knownTables
                ? `Orphan drop in UP: '${dropped}' was not created by any earlier migration and is not listed in validation.existingTables — check the name (or declare the table there if it predates these migrations)`
                : `Orphan drop in UP: '${dropped}' is dropped but not created in this migration`
            });
          }
        }
      }
    }

    // Detect valid CREATE/DROP pairs (always false in repeatable mode — no UP/DOWN sections)
    const hasValidCreateDropPair = this.config.mode !== 'repeatable' &&
      createdTables.length > 0 && 
      droppedTablesInDown.every(d => createdTables.map(t => t.toLowerCase()).includes(d.toLowerCase()));

    // === 2c. DDL only: Check FK references against tables dropped in the same UP section ===
    // Set-membership only (no statement-order tracking), same as the
    // cross-file FK checker (validateCrossFileFKDependencies()) — a table
    // dropped AND recreated later in the same UP section is not "dropped"
    // for this purpose, matching that checker's existing behavior. Without
    // this, `DROP TABLE users; CREATE TABLE users(...); CREATE TABLE orders(
    // FOREIGN KEY ... REFERENCES users(id))` false-positives even though the
    // FK is valid by the time `orders` is created. See docs/VALIDATION-RULES-MARIADB.md.
    if (this.config.mode !== 'repeatable') {
      const fkRefs = this.extractFKReferences(upSQL);
      const createdTablesSet = new Set(createdTables.map(t => t.toLowerCase()));
      const droppedInUpSet = new Set(
        droppedTablesInUp.map(t => t.toLowerCase()).filter(t => !createdTablesSet.has(t))
      );

      for (const fk of fkRefs) {
        if (droppedInUpSet.has(fk.referencedTable)) {
          const nameLabel = fk.constraintName ? ` '${fk.constraintName}'` : '';
          errors.push({
            type: 'fk-dropped-table',
            code: 'FK_REFERENCES_DROPPED_TABLE',
            message: `🔴 FOREIGN KEY${nameLabel} references '${fk.referencedTable}' which is dropped in the same migration UP section`
          });
        }
      }
    }

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
          // Forbid DROP DATABASE in UP section unless explicitly approved via @allow-forbidden.
          // Only the rule whose own pattern matches reports it: DROP DATABASE
          // is DROP_DATABASE, DROP SCHEMA is DROP_SCHEMA — not both for either,
          // or allowing the one code shown could never be enough.
          if (hasDropDatabaseInUp || /DROP\s+SCHEMA/i.test(normalizedUpSQL)) {
            if (!rule.pattern.test(normalizedUpSQL)) continue;
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
    // Per statement, not against the whole section: "has no WHERE" has to
    // mean *this* statement has none. normalizeSQL() already replaced string
    // literals and stripped comments, so splitting on ';' is safe here.
    const checkStatements = normalizedCheckTarget.split(';').map(st => st.trim()).filter(Boolean);
    for (const category of Object.keys(rules.dangerous)) {
      for (const rule of rules.dangerous[category]) {
        // Only check UP section (or full content for files without UP/DOWN markers)
        if (checkStatements.some(st => rule.pattern.test(st))) {
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

    // === 8b. DDL only: a file with no Up marker would never run (up() rejects it) ===
    if (this.config.mode !== 'repeatable' && !this.hasSection(content, 'Up')) {
      errors.push({
        type: 'missing-up-marker',
        code: 'MISSING_UP_MARKER',
        message: `🔴 ${this.missingUpMarkerMessage()}`
      });
    }

    // === 9. DDL only: Check if DOWN section exists (R__ repeatable files have no DOWN) ===
    // Mirrors the MongoDB adapter's equivalent check: an empty/missing DOWN
    // is only a hard error when UP actually did something that needs
    // rolling back. A no-op or comment-only migration with no DOWN is still
    // just a warning, not a blocker.
    if (this.config.mode !== 'repeatable' && (!downSQL || downSQL.trim() === '')) {
      const upHasOperations = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|INSERT\s+INTO)\b/i.test(normalizedUpSQL);
      if (upHasOperations) {
        errors.push({
          type: 'missing-down',
          code: 'MISSING_DOWN',
          message: '🔴 DOWN migration is empty or missing but UP contains operations — rollback missing!'
        });
      } else {
        warnings.push({
          type: 'missing-down',
          message: '⚠️ DOWN migration is empty or missing'
        });
      }
    }

    // Project policy (validation.customRules / validation.rules — see BaseAdapter.getValidationPolicy())
    this.evaluateCustomRules(checkStatements, options, { forbiddenOps, dangerousOps, warnings });
    const policy = this.applyApproval(this.applyRulePolicy({ errors, forbiddenOps, dangerousOps, warnings }), fileAnnotations.approvedBy || options.approvedBy);

    // Combine errors: forbidden ops + dangerous ops (when not allowed) + structural errors
    const allErrors = [...policy.errors, ...policy.forbiddenOps, ...policy.dangerousOps];

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: policy.warnings,
      forbiddenOps: policy.forbiddenOps,
      dangerousOps: policy.dangerousOps,
      approval: policy.approval,
      suspiciousNames: suspiciousNameWarnings,
      performanceIssues: performanceWarnings,
      performanceMetrics: performanceResult.metrics,
      summary: {
        forbidden: policy.forbiddenOps.length,
        dangerous: policy.dangerousOps.length,
        warnings: policy.warnings.length,
        structural: policy.errors.length,
        suspiciousNames: suspiciousNameWarnings.length,
        performanceIssues: performanceWarnings.length
      }
    };
  }

  extractCreatedTables(sql) {
    const tables = [];
    // Remove comments
    const cleanSQL = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // CREATE [OR REPLACE] TABLE [IF NOT EXISTS] [schema.]table  (Bug 2 + 4)
    const createRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"]?[\w$]+[`"]?\.)?\s*[`"]?([\w$]+)[`"]?/gi;
    let match;
    while ((match = createRegex.exec(cleanSQL)) !== null) {
      tables.push(match[1]);
    }
    // RENAME TABLE old TO new [, old2 TO new2] — new names become "created"  (Bug 3)
    const renameRegex = /RENAME\s+TABLE\s+(.+?)(?:;|$)/gi;
    let renameMatch;
    while ((renameMatch = renameRegex.exec(cleanSQL)) !== null) {
      for (const part of renameMatch[1].split(',')) {
        const toMatch = part.match(/\bTO\s+(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?/i);
        if (toMatch) tables.push(toMatch[1]);
      }
    }
    return tables;
  }

  extractDroppedTables(sql) {
    const tables = [];
    // Strip routine bodies first to avoid counting DROP TABLE inside procedures  (Bug 5)
    const cleanSQL = this._stripRoutineBodies(sql)
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // DROP TABLE [IF EXISTS] tbl1 [, tbl2, tbl3] — may be schema-qualified  (Bug 1 + 2)
    const dropStmtRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?(?:\s*,\s*(?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)*)/gi;
    let stmtMatch;
    while ((stmtMatch = dropStmtRegex.exec(cleanSQL)) !== null) {
      for (const entry of stmtMatch[1].split(',')) {
        const m = entry.trim().match(/(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?/);
        if (m) tables.push(m[1]);
      }
    }
    return tables;
  }

  _stripRoutineBodies(sql) {
    if (!sql) return sql;
    // Strip CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT bodies so that DDL statements
    // inside routine bodies are not mistaken for migration-level DDL.  (Bug 5)
    // Compound-statement END always has a trailing keyword (IF, WHILE, LOOP, CASE, REPEAT).
    // Only the routine-closing END stands alone (followed by ; or $$ or whitespace/EOF).
    return sql.replace(
      /\bCREATE\b(?:\s+(?:DEFINER\s*=\s*\S+|OR\s+REPLACE))*\s+(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b[^;]{0,2000}?\bBEGIN\b[\s\S]{0,10000}?\bEND\b(?!\s*(?:IF|WHILE|LOOP|CASE|REPEAT)\b)/gi,
      '-- [routine stripped]'
    );
  }

  /**
   * Extract all FOREIGN KEY references from SQL.
   * Supports all MariaDB FK syntax variants:
   *   - Named inline:    CONSTRAINT `fk_name` FOREIGN KEY (col) REFERENCES tbl(id)
   *   - Unnamed inline:  FOREIGN KEY (col) REFERENCES tbl(id) ON DELETE CASCADE
   *   - ALTER TABLE ADD CONSTRAINT fk FOREIGN KEY (col) REFERENCES tbl(id)
   *   - ALTER TABLE ADD FOREIGN KEY (col) REFERENCES tbl(id)
   *   - Schema-qualified: REFERENCES `other_db`.`tbl`(id)  → schema stripped
   *   - Self-referential: REFERENCES same_table(id)
   *   - Multi-column FK: FOREIGN KEY (a, b) REFERENCES tbl(x, y)
   *   - Multi-line formatted FKs
   *
   * ON DELETE / ON UPDATE order-independent (each captured separately).
   *
   * @param {string} sql - SQL content (UP section or full file)
   * @returns {{ constraintName: string|null, referencedTable: string,
   *             referencedSchema: string|null, onDelete: string|null, onUpdate: string|null }[]}
   */
  extractFKReferences(sql) {
    if (!sql) return [];

    // Fix B: Strip zero-width characters (Unicode confusion bypass prevention)
    // eslint-disable-next-line no-misleading-character-class -- distinct zero-width codepoints to strip, not a joined sequence
    sql = sql.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '');
    // Fix C: Convert fullwidth characters to halfwidth (align with normalizeSQL)
    sql = sql.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

    sql = this._stripRoutineBodies(sql);

    // Strip comments and single-quoted string literals to avoid false positives.
    // Double-quoted strings are kept because MariaDB uses them as identifiers (ANSI mode)
    // when they appear in CONSTRAINT "name" syntax.
    const cleanSQL = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "'__STR__'");

    const fks = [];

    // Fix A: REFERENCES clause now handles:
    //   - quoted schema/table identifiers using [^`"]+ (supports hyphens, $, spaces)
    //   - unquoted schema/table identifiers using [\w$]+ (supports $ per MariaDB spec)
    // Groups: 1=quoted constraint name, 2=unquoted constraint name,
    //         3=quoted schema, 4=unquoted schema,
    //         5=quoted table,  6=unquoted table,
    //         7=ON clause
    const fkRegex = /(?:CONSTRAINT\s+(?:[`"]([^`"]+)[`"]|(\w+))\s+)?FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+(?:(?:[`"]([^`"]+)[`"]|([\w$]+))\.)?(?:[`"]([^`"]+)[`"]|([\w$]+))\s*(?:\([^)]+\))?\s*((?:ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|SET\s+(?:NULL|DEFAULT)|CASCADE|RESTRICT)\s*)*)/gi;

    let match;
    while ((match = fkRegex.exec(cleanSQL)) !== null) {
      const actionClause = match[7] || '';

      // Extract ON DELETE and ON UPDATE independently (order-insensitive)
      const onDeleteMatch = actionClause.match(/ON\s+DELETE\s+(NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT)/i);
      const onUpdateMatch = actionClause.match(/ON\s+UPDATE\s+(NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT|CASCADE|RESTRICT)/i);

      const rawSchema = match[3] || match[4] || null;
      const rawTable  = match[5] || match[6] || '';

      fks.push({
        constraintName: match[1] || match[2] || null,
        referencedSchema: rawSchema ? rawSchema.replace(/[`"]/g, '') : null,
        referencedTable: rawTable.replace(/[`"]/g, '').toLowerCase(),
        onDelete: onDeleteMatch ? onDeleteMatch[1].toUpperCase().replace(/\s+/g, ' ').trim() : null,
        onUpdate: onUpdateMatch ? onUpdateMatch[1].toUpperCase().replace(/\s+/g, ' ').trim() : null
      });
    }

    return fks;
  }

  /**
   * For each file (in run order), the tables that exist before it runs:
   * validation.existingTables plus everything earlier files created and
   * didn't drop (RENAME counts as drop old + create new).
   * @returns {Array<Map<string, string>>} lowercase table → where it came from
   */
  tablesBeforeEachFile(filesData) {
    const known = new Map(this.getValidationConfig().existing.map(t => [t, 'listed in validation.existingTables']));
    const out = [];
    for (const { fileName, content } of filesData) {
      out.push(new Map(known));
      const upSQL = this.extractSection(content, 'Up') || content;
      const renamedFrom = [];
      const cleanUpSQL = upSQL.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of cleanUpSQL.matchAll(/RENAME\s+TABLE\s+(.+?)(?:;|$)/gi)) {
        for (const part of m[1].split(',')) {
          const from = part.match(/(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?\s+TO\s+/i);
          if (from) renamedFrom.push(from[1].toLowerCase());
        }
      }
      for (const t of [...this.extractDroppedTables(upSQL), ...renamedFrom]) known.delete(t.toLowerCase());
      for (const t of this.extractCreatedTables(upSQL)) known.set(t.toLowerCase(), `created by ${fileName}`);
    }
    return out;
  }

  /**
   * Validate FK dependencies across multiple migration files (DDL mode only).
   * Files must be provided in execution order (sorted lexicographically by caller).
   *
   * Detects: FK referencing a table that has not yet been created in any prior migration.
   * Self-referential FKs (table references itself) are allowed.
   * Schema-qualified references (db.table) strip the schema and check only table name.
   * Tables dropped in a file are removed from the available set for subsequent files.
   *
   * A table this tool never saw created — baselined via `baseline` rather
   * than an actual CREATE TABLE migration, or pre-existing in an onboarded
   * database — makes this a false positive this check can't distinguish
   * from a genuinely broken reference, so (like ORPHAN_DROP_*) it's
   * bypassable via --allow-dangerous or --allow FK_UNRESOLVED_REFERENCE
   * (CLI-wide or the referencing file's own annotation).
   *
   * @param {{ fileName: string, content: string }[]} filesData - sorted migration files
   * @param {Object} [options] - allowDangerous / allowedCodes, same shape validateContent() takes
   * @returns {{ fileName: string, errors: Array, warnings: Array }[]}
   */
  validateCrossFileFKDependencies(filesData, options = {}) {
    if (!filesData || filesData.length === 0) return [];
    if (this.config.mode === 'repeatable') return [];

    // lowercase table names created in prior files, plus validation.existingTables
    const allCreatedTables = new Set(this.getValidationConfig().existing);
    const crossErrors = [];

    for (const { fileName, content } of filesData) {
      const upSQL = this.extractSection(content, 'Up') || content;

      const createdNow = this.extractCreatedTables(upSQL).map(t => t.toLowerCase());
      const droppedNow = this.extractDroppedTables(upSQL).map(t => t.toLowerCase());
      const fkRefs = this.extractFKReferences(upSQL);

      // RENAME TABLE old TO new — treat old name as dropped for cross-file tracking  (Bug 3)
      const cleanUpSQL = upSQL.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const renameRe = /RENAME\s+TABLE\s+(.+?)(?:;|$)/gi;
      let renameMx;
      while ((renameMx = renameRe.exec(cleanUpSQL)) !== null) {
        for (const part of renameMx[1].split(',')) {
          const fromMx = part.match(/(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?\s+TO\s+/i);
          if (fromMx) droppedNow.push(fromMx[1].toLowerCase());
        }
      }

      // Tables dropped in this file are no longer available to subsequent files
      for (const t of droppedNow) {
        allCreatedTables.delete(t);
      }

      // Available = all previously seen tables + tables created in THIS file (same-file self-ref OK)
      const availableNow = new Set([...allCreatedTables, ...createdNow]);

      // Per-file annotations can allow this the same way validateContent()'s
      // own checks do; CLI-wide --allow-dangerous/--allow applies to every file.
      const fileAnnotations = this.parseFileAnnotations(content, fileName);
      const isAllowed = options.allowDangerous || fileAnnotations.allowDangerous ||
        [
          ...(options.allowedCodes || []),
          ...(fileAnnotations.allowedCodes || []),
          ...(this.getValidationConfig().allow[fileName] || [])
        ].includes('FK_UNRESOLVED_REFERENCE');

      const fileErrors = [];
      const fileWarnings = [];
      for (const fk of fkRefs) {
        const ref = fk.referencedTable; // already lowercased
        if (!availableNow.has(ref)) {
          const nameLabel = fk.constraintName ? ` '${fk.constraintName}'` : '';
          const message = `FOREIGN KEY${nameLabel} references '${fk.referencedTable}' which has not been created in any preceding migration (if it predates these migrations, list it in validation.existingTables)`;
          const fkSetting = this.getValidationPolicy().rules.FK_UNRESOLVED_REFERENCE;
          if (fkSetting === 'off') continue;
          if (fkSetting === 'warn') {
            fileWarnings.push({ type: 'downgraded', code: 'FK_UNRESOLVED_REFERENCE', message: `⚠️ [warn via validation.rules] ${message}` });
          } else if (isAllowed) {
            fileWarnings.push({ type: 'fk-unresolved-reference-allowed', code: 'FK_UNRESOLVED_REFERENCE', message: `⚠️ [ALLOWED] ${message} — assumed to exist via baseline or an externally-managed table` });
          } else {
            fileErrors.push({ type: 'fk-unresolved-reference', code: 'FK_UNRESOLVED_REFERENCE', message: `🔴 ${message}` });
          }
        }
      }

      if (fileErrors.length > 0 || fileWarnings.length > 0) {
        crossErrors.push({ fileName, errors: fileErrors, warnings: fileWarnings });
      }

      // After processing this file, its created tables are available to subsequent files
      for (const t of createdNow) {
        allCreatedTables.add(t);
      }
      // A table created AND dropped in the same file must not persist into subsequent files.
      // (The start-of-loop deletion only handles tables that existed from prior files.)
      for (const t of droppedNow) {
        allCreatedTables.delete(t);
      }
    }

    return crossErrors;
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
      // eslint-disable-next-line no-misleading-character-class -- distinct zero-width codepoints to strip, not a joined sequence
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
  checkPerformanceIssues(sql, _fileName = '') {
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
