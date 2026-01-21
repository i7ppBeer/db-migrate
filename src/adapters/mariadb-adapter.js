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
   */
  getValidationRules() {
    return {
      forbidden: {
        database: [
          { pattern: /DROP\s+DATABASE/i, message: 'DATA LOSS: 禁止刪除資料庫' },
          { pattern: /DROP\s+SCHEMA/i, message: 'DATA LOSS: 禁止刪除 SCHEMA' },
          { pattern: /TRUNCATE\s+TABLE/i, message: 'DATA LOSS: 禁止 TRUNCATE' }
        ],
        dcl: [
          // Match exact "CREATE USER" and "DROP USER" SQL statements
          { pattern: /\bCREATE\s+USER\s+['"`@]/i, message: 'DCL: 使用者管理應在 _platform 專案' },
          { pattern: /\bDROP\s+USER\s+(?:IF\s+EXISTS\s+)?['"`@]/i, message: 'DCL: 使用者管理應在 _platform 專案' },
          { pattern: /\bALTER\s+USER\s+['"`@]/i, message: 'DCL: 使用者管理應在 _platform 專案' },
          { pattern: /\bSET\s+PASSWORD\s+FOR/i, message: 'DCL: 密碼管理應在 _platform 專案' },
          { pattern: /\bGRANT\s+(?:ALL|USAGE|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, message: 'DCL: 權限管理應在 _platform 專案' },
          { pattern: /\bREVOKE\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE)\s*(?:PRIVILEGES\s+)?(?:ON|,)/i, message: 'DCL: 權限管理應在 _platform 專案' },
          { pattern: /\bFLUSH\s+PRIVILEGES/i, message: 'DCL: 權限管理應在 _platform 專案' }
        ],
        dataExfiltration: [
          { pattern: /\bSELECT\s+.*\s+INTO\s+OUTFILE/i, message: 'DATA RISK: 禁止匯出資料到檔案' },
          { pattern: /\bLOAD\s+DATA\s+(?:LOCAL\s+)?INFILE/i, message: 'DATA RISK: 禁止從檔案載入資料' },
          { pattern: /\bINTO\s+DUMPFILE/i, message: 'DATA RISK: 禁止匯出資料' }
        ],
        blocking: [
          { pattern: /LOCK\s+TABLE/i, message: 'BLOCKING: 禁止手動鎖表' }
        ]
      },
      warnings: {
        operations: [
          { pattern: /DELETE\s+FROM(?![^;]*WHERE)/i, message: 'DELETE 缺少 WHERE 條件' },
          { pattern: /UPDATE\s+\w+\s+SET(?![^;]*WHERE)/i, message: 'UPDATE 缺少 WHERE 條件' },
          { pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i, message: 'DROP COLUMN 會造成資料遺失' },
          { pattern: /ALTER\s+TABLE.*MODIFY.*NOT\s+NULL(?![^;]*DEFAULT)/i, message: '新增 NOT NULL 應有 DEFAULT' }
        ]
      },
      createDropPairs: {
        // Used to detect CREATE/DROP pairs for smart allowance
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

  async validate() {
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
        const fileResult = this.validateContent(content, file);
        
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

  validateContent(content, fileName) {
    const errors = [];
    const warnings = [];
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
          message: `Orphan drop: DOWN drops '${dropped}' but UP doesn't create it`
        });
      }
    }

    // === 2b. Check for orphan drops in UP section (dropping tables not created in this migration) ===
    for (const dropped of droppedTablesInUp) {
      if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
        errors.push({
          type: 'orphan-drop-in-up',
          message: `Orphan drop in UP: '${dropped}' is dropped but not created in this migration`
        });
      }
    }

    // Detect valid CREATE/DROP pairs
    const hasValidCreateDropPair = createdTables.length > 0 && 
      droppedTablesInDown.every(d => createdTables.map(t => t.toLowerCase()).includes(d.toLowerCase()));

    // === 3. Check forbidden operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const rule of rules.forbidden[category]) {
        // Smart allowance: Skip DROP TABLE check if it's a valid CREATE/DROP pair
        if (hasValidCreateDropPair && rule.pattern.toString().includes('DROP\\s+TABLE')) {
          const dropInUp = rules.createDropPairs.drop.test(upSQL);
          if (!dropInUp) {
            warnings.push({
              type: 'allowed-drop-for-create',
              message: `[ALLOWED] DROP TABLE in down() because up() creates table`
            });
            continue;
          }
        }

        if (rule.pattern.test(content)) {
          errors.push({
            type: `forbidden-${category}-operation`,
            message: rule.message
          });
        }
      }
    }

    // === 4. Check warning operations ===
    for (const rule of rules.warnings.operations) {
      if (rule.pattern.test(content)) {
        warnings.push({
          type: 'warning-operation',
          message: rule.message
        });
      }
    }

    // === 5. Check if DOWN section exists ===
    if (!downSQL || downSQL.trim() === '') {
      warnings.push({
        type: 'missing-down',
        message: 'DOWN migration is empty or missing'
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
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
