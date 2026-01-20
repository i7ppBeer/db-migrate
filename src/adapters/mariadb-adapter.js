/**
 * MariaDB/MySQL Adapter
 * Implements SQL migrations using sql-migrate pattern
 */

import { BaseAdapter } from '../core/base-adapter.js';
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';

export class MariaDBAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.dbType = 'mariadb';
    this.connection = null;
    this.changelogTable = config.changelogTable || 'schema_migrations';
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
