/**
 * MariaDB/MySQL Adapter
 * Implements SQL migrations using sql-migrate pattern
 */

import { BaseAdapter } from '../core/base-adapter.js';
import { SanityChecker, SQLChecks } from '../core/sanity-checker.js';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';

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
  getValidationRules() {
    return {
      // ========================================
      // 🔴 絕對禁止 - 預設無法放行 (需 --allow-forbidden)
      // ========================================
      forbidden: {
        database: [
          { pattern: /DROP\s+DATABASE/i, code: 'DROP_DATABASE', message: '🔴 DATA LOSS: 禁止刪除資料庫' },
          { pattern: /DROP\s+SCHEMA/i, code: 'DROP_SCHEMA', message: '🔴 DATA LOSS: 禁止刪除 SCHEMA' }
        ],
        dcl: [
          { pattern: /\bCREATE\s+USER\s+['"`@]/i, code: 'CREATE_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bDROP\s+USER\s+(?:IF\s+EXISTS\s+)?['"`@]/i, code: 'DROP_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bALTER\s+USER\s+['"`@]/i, code: 'ALTER_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bSET\s+PASSWORD\s+FOR/i, code: 'SET_PASSWORD', message: '🔴 DCL: 密碼管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bGRANT\s+(?:ALL|USAGE|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, code: 'GRANT', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bREVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, code: 'REVOKE', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\bFLUSH\s+PRIVILEGES/i, code: 'FLUSH_PRIVILEGES', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' }
        ],
        dataExfiltration: [
          { pattern: /\bSELECT\s+.*\s+INTO\s+OUTFILE/i, code: 'INTO_OUTFILE', message: '🔴 DATA RISK: 禁止匯出資料到檔案' },
          { pattern: /\bLOAD\s+DATA\s+(?:LOCAL\s+)?INFILE/i, code: 'LOAD_DATA', message: '🔴 DATA RISK: 禁止從檔案載入資料' },
          { pattern: /\bINTO\s+DUMPFILE/i, code: 'INTO_DUMPFILE', message: '🔴 DATA RISK: 禁止匯出資料' }
        ],
        system: [
          { pattern: /\bSHUTDOWN/i, code: 'SHUTDOWN', message: '🔴 SYSTEM: 禁止關閉資料庫' },
          { pattern: /\bRESET\s+MASTER/i, code: 'RESET_MASTER', message: '🔴 SYSTEM: 禁止重置主庫' },
          { pattern: /\bRESET\s+SLAVE/i, code: 'RESET_SLAVE', message: '🔴 SYSTEM: 禁止重置從庫' },
          { pattern: /\bSTOP\s+SLAVE/i, code: 'STOP_SLAVE', message: '🔴 SYSTEM: 禁止停止複製' },
          { pattern: /\bCHANGE\s+MASTER/i, code: 'CHANGE_MASTER', message: '🔴 SYSTEM: 禁止變更主庫設定' },
          { pattern: /\bSET\s+GLOBAL/i, code: 'SET_GLOBAL', message: '🔴 SYSTEM: 禁止變更全域設定' },
          { pattern: /\bKILL\s+(?:CONNECTION|QUERY)/i, code: 'KILL', message: '🔴 SYSTEM: 禁止終止連線/查詢' }
        ]
      },

      // ========================================
      // 🟠 危險操作 - 可用 --allow-dangerous 放行
      // ========================================
      dangerous: {
        dataLoss: [
          { pattern: /TRUNCATE\s+TABLE/i, code: 'TRUNCATE_TABLE', message: '🟠 DATA LOSS: TRUNCATE TABLE 會清空全表資料', suggestion: '建議改用 DELETE FROM table WHERE condition' }
        ],
        blocking: [
          { pattern: /LOCK\s+TABLE/i, code: 'LOCK_TABLE', message: '🟠 BLOCKING: LOCK TABLE 會阻塞所有查詢', suggestion: '考慮使用交易隔離等級或行鎖' },
          { pattern: /ALTER\s+TABLE\s+\w+\s+(?:ADD|DROP|MODIFY|CHANGE)\s+(?!.*ALGORITHM\s*=\s*INPLACE)/i, code: 'ALTER_TABLE_BLOCKING', message: '🟠 BLOCKING: ALTER TABLE 可能造成長時間鎖表', suggestion: '建議使用 ALGORITHM=INPLACE, LOCK=NONE 或 pt-online-schema-change' },
          { pattern: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(?!.*ALGORITHM\s*=\s*INPLACE)/i, code: 'CREATE_INDEX_BLOCKING', message: '🟠 BLOCKING: CREATE INDEX 可能造成長時間鎖表', suggestion: '建議使用 ALGORITHM=INPLACE, LOCK=NONE' },
          { pattern: /SELECT\s+[\s\S]*?\s+FOR\s+UPDATE/i, code: 'SELECT_FOR_UPDATE', message: '🟠 BLOCKING: SELECT FOR UPDATE 會造成排他行鎖', suggestion: '確認是否真的需要鎖定，考慮使用樂觀鎖' },
          { pattern: /SELECT\s+[\s\S]*?\s+LOCK\s+IN\s+SHARE\s+MODE/i, code: 'LOCK_IN_SHARE_MODE', message: '🟠 BLOCKING: LOCK IN SHARE MODE 會造成共享行鎖', suggestion: '確認是否真的需要共享鎖' }
        ],
        bulkOperation: [
          { pattern: /DELETE\s+FROM\s+\w+\s*(?:;|$)/i, code: 'DELETE_ALL', message: '🟠 DATA RISK: DELETE 缺少 WHERE 條件，會刪除全表資料', suggestion: '請加上 WHERE 條件' },
          { pattern: /UPDATE\s+\w+\s+SET\s+[^;]*(?:;|$)(?![\s\S]*WHERE)/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: UPDATE 缺少 WHERE 條件，會更新全表資料', suggestion: '請加上 WHERE 條件' },
          { pattern: /INSERT\s+[\s\S]*?\s+SELECT\s+/i, code: 'INSERT_SELECT', message: '🟠 BLOCKING: INSERT...SELECT 會對來源表加共享鎖', suggestion: '考慮分批處理' }
        ],
        schemaChange: [
          { pattern: /ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i, code: 'DROP_COLUMN', message: '🟠 DATA LOSS: DROP COLUMN 會永久刪除欄位資料', suggestion: '先確認該欄位已無使用' },
          { pattern: /RENAME\s+TABLE/i, code: 'RENAME_TABLE', message: '🟠 BREAKING: RENAME TABLE 可能破壞應用程式', suggestion: '確認所有應用程式都已更新表名引用' },
          { pattern: /ALTER\s+TABLE\s+\w+\s+RENAME\s+TO/i, code: 'ALTER_RENAME', message: '🟠 BREAKING: RENAME TABLE 可能破壞應用程式', suggestion: '確認所有應用程式都已更新表名引用' },
          { pattern: /MODIFY\s+COLUMN\s+\w+\s+\w+/i, code: 'MODIFY_COLUMN', message: '🟠 DATA RISK: MODIFY COLUMN 可能造成資料轉換失敗', suggestion: '先在測試環境驗證' },
          { pattern: /CHANGE\s+COLUMN/i, code: 'CHANGE_COLUMN', message: '🟠 DATA RISK: CHANGE COLUMN 可能造成資料轉換失敗', suggestion: '先在測試環境驗證' },
          { pattern: /DROP\s+INDEX/i, code: 'DROP_INDEX', message: '🟠 PERFORMANCE: DROP INDEX 可能影響查詢效能', suggestion: '確認該索引已無查詢使用' },
          { pattern: /DROP\s+(?:PRIMARY\s+)?KEY/i, code: 'DROP_KEY', message: '🟠 BREAKING: DROP KEY 可能影響資料完整性', suggestion: '確認外鍵關聯已處理' },
          { pattern: /DROP\s+FOREIGN\s+KEY/i, code: 'DROP_FOREIGN_KEY', message: '🟠 BREAKING: DROP FOREIGN KEY 會移除資料完整性約束', suggestion: '確認應用程式層有對應驗證' }
        ]
      },

      // ========================================
      // 🟡 警告提示 - 不阻擋執行
      // ========================================
      warnings: {
        operations: [
          { pattern: /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN/i, message: '⚠️ ALTER TABLE ADD COLUMN 在大表上可能需要較長時間' },
          { pattern: /ADD\s+(?:CONSTRAINT\s+)?\w*\s*NOT\s+NULL(?!\s+DEFAULT)/i, message: '⚠️ 新增 NOT NULL 欄位建議搭配 DEFAULT 值' },
          { pattern: /AUTO_INCREMENT\s*=/i, message: '⚠️ 手動設定 AUTO_INCREMENT 可能造成 ID 衝突' },
          { pattern: /ENGINE\s*=\s*MyISAM/i, message: '⚠️ MyISAM 引擎不支援交易，建議使用 InnoDB' },
          { pattern: /CHARSET\s*=\s*(?:latin1|utf8[^m])/i, message: '⚠️ 建議使用 utf8mb4 字元集' },
          { pattern: /\b(?:FLOAT|DOUBLE)\b/i, message: '⚠️ FLOAT/DOUBLE 有精度問題，金額建議用 DECIMAL' },
          { pattern: /DATETIME(?!\s*\(\d+\))/i, message: '⚠️ DATETIME 沒有指定精度，微秒會被截斷' },
          { pattern: /ON\s+DELETE\s+CASCADE/i, message: '⚠️ ON DELETE CASCADE 可能造成連鎖刪除' },
          { pattern: /ON\s+UPDATE\s+CASCADE/i, message: '⚠️ ON UPDATE CASCADE 可能造成連鎖更新' }
        ]
      },

      // ========================================
      // CREATE/DROP 配對檢測
      // ========================================
      createDropPairs: {
        create: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i,
        drop: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/i
      }
    };
  }

  async connect() {
    try {
      this.connection = await mysql.createConnection({
        host: this.config.host || 'localhost',
        port: this.config.port || 3306,
        user: this.config.user || 'root',
        password: this.config.password || '',
        database: this.config.database,
        multipleStatements: true
      });

      // Ensure changelog table exists
      await this.ensureChangelogTable();
      
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
    await this.connection.execute(`
      CREATE TABLE IF NOT EXISTS ${this.changelogTable} (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async status() {
    try {
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

  async up() {
    const result = {
      applied: [],
      errors: []
    };

    try {
      const status = await this.status();
      
      for (const file of status.pending) {
        try {
          const filePath = path.join(this.config.migrationsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          
          // Extract UP section
          const upSQL = this.extractSection(content, 'Up');
          
          if (upSQL) {
            await this.connection.execute(upSQL);
            
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
                  await this.connection.execute(upSQL);
                  const id = file.replace('.sql', '');
                  await this.connection.execute(
                    `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
                    [id]
                  );
                }
              },
              down: async () => {
                if (downSQL) {
                  await this.connection.execute(downSQL);
                  const id = file.replace('.sql', '');
                  await this.connection.execute(
                    `DELETE FROM ${this.changelogTable} WHERE id = ?`,
                    [id]
                  );
                }
              },
              preCheck: preCheckSQL ? async () => {
                return await this.executeSanityCheck(preCheckSQL);
              } : null,
              postCheck: postCheckSQL ? async () => {
                return await this.executeSanityCheck(postCheckSQL);
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
            // No sanity checks, run normally
            if (upSQL) {
              await this.connection.execute(upSQL);
              const id = file.replace('.sql', '');
              await this.connection.execute(
                `INSERT INTO ${this.changelogTable} (id) VALUES (?)`,
                [id]
              );
              result.applied.push(file);
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
   */
  extractSanitySection(content, sectionName) {
    const regex = new RegExp(
      `--\\s*\\+sanity\\s+${sectionName}\\s*\\n([\\s\\S]*?)--\\s*-sanity\\s+${sectionName}`,
      'i'
    );
    const match = content.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Execute sanity check SQL and interpret results
   * Returns { success: true/false, error: string, details: [] }
   */
  async executeSanityCheck(sql) {
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
            await this.connection.execute(downSQL);
            
            // Remove from changelog
            const id = migration.fileName.replace('.sql', '');
            await this.connection.execute(
              `DELETE FROM ${this.changelogTable} WHERE id = ?`,
              [id]
            );
            
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
   * Validate migration content
   * @param {string} content - Migration file content
   * @param {string} fileName - File name
   * @param {Object} options - Validation options
   * @param {boolean} options.allowDangerous - Allow dangerous operations
   * @param {boolean} options.allowForbidden - Allow forbidden operations (requires approval)
   * @param {string[]} options.allowedCodes - Specific codes to allow
   */
  validateContent(content, fileName, options = {}) {
    const errors = [];
    const warnings = [];
    const dangerousOps = [];
    const forbiddenOps = [];
    const rules = this.getValidationRules();

    const upSQL = this.extractSection(content, 'Up');
    const downSQL = this.extractSection(content, 'Down');

    // === 1. Extract created and dropped tables ===
    const createdTables = this.extractCreatedTables(upSQL);
    const droppedTablesInDown = this.extractDroppedTables(downSQL);
    const droppedTablesInUp = this.extractDroppedTables(upSQL);

    // === 2. Check for orphan drops in DOWN section ===
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

    // Detect valid CREATE/DROP pairs
    const hasValidCreateDropPair = createdTables.length > 0 && 
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

        if (rule.pattern.test(content)) {
          const isAllowed = options.allowForbidden || 
            (options.allowedCodes && options.allowedCodes.includes(rule.code));
          
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

    // === 4. Check DANGEROUS operations ===
    for (const category of Object.keys(rules.dangerous)) {
      for (const rule of rules.dangerous[category]) {
        if (rule.pattern.test(content)) {
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

    // === 5. Check WARNING operations ===
    for (const rule of rules.warnings.operations) {
      if (rule.pattern.test(content)) {
        warnings.push({
          type: 'warning',
          message: rule.message
        });
      }
    }

    // === 6. Check if DOWN section exists ===
    if (!downSQL || downSQL.trim() === '') {
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
      summary: {
        forbidden: forbiddenOps.length,
        dangerous: dangerousOps.length,
        warnings: warnings.length,
        structural: errors.length
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
    return match ? match[1].trim() : '';
  }
}

export default MariaDBAdapter;
