/**
 * MongoDB Adapter
 * Wraps migrate-mongo for MongoDB migrations
 */

import { BaseAdapter } from '../core/base-adapter.js';
import { SanityChecker, MongoDBChecks } from '../core/sanity-checker.js';
import migrateMongo from 'migrate-mongo';
import { MongoClient } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';

export class MongoDBAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.dbType = 'mongodb';
    this.client = null;
    this.db = null;
    this.sanityChecker = new SanityChecker({
      enabled: config.sanityCheck?.enabled ?? false,
      autoRollback: config.sanityCheck?.autoRollback ?? true,
      timeoutMs: config.sanityCheck?.timeoutMs ?? 30000,
      verbose: config.sanityCheck?.verbose ?? true
    });
  }

  /**
   * Get sanity check helpers for MongoDB
   */
  getSanityCheckHelpers() {
    return MongoDBChecks;
  }

  /**
   * Get MongoDB-specific validation rules
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
          { pattern: /\.dropDatabase\s*\(/i, code: 'DROP_DATABASE', message: '🔴 DATA LOSS: 禁止刪除資料庫' },
          { pattern: /dropDatabase\s*:\s*(?:true|1)/i, code: 'DROP_DATABASE_CMD', message: '🔴 DATA LOSS: 禁止刪除資料庫' }
        ],
        dcl: [
          { pattern: /\.createUser\s*\(/i, code: 'CREATE_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /createUser\s*:/i, code: 'CREATE_USER_CMD', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.dropUser\s*\(/i, code: 'DROP_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /dropUser\s*:/i, code: 'DROP_USER_CMD', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.updateUser\s*\(/i, code: 'UPDATE_USER', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /updateUser\s*:/i, code: 'UPDATE_USER_CMD', message: '🔴 DCL: 使用者管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.grantRolesToUser\s*\(/i, code: 'GRANT_ROLES', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /grantRolesToUser\s*:/i, code: 'GRANT_ROLES_CMD', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.revokeRolesFromUser\s*\(/i, code: 'REVOKE_ROLES', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /revokeRolesFromUser\s*:/i, code: 'REVOKE_ROLES_CMD', message: '🔴 DCL: 權限管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.createRole\s*\(/i, code: 'CREATE_ROLE', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' },
          { pattern: /createRole\s*:/i, code: 'CREATE_ROLE_CMD', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.dropRole\s*\(/i, code: 'DROP_ROLE', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' },
          { pattern: /dropRole\s*:/i, code: 'DROP_ROLE_CMD', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' },
          { pattern: /\.updateRole\s*\(/i, code: 'UPDATE_ROLE', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' },
          { pattern: /updateRole\s*:/i, code: 'UPDATE_ROLE_CMD', message: '🔴 DCL: 角色管理應在 DCL 專案 (Repeatable)' }
        ],
        system: [
          { pattern: /shutdown\s*:\s*(?:true|1)/i, code: 'SHUTDOWN', message: '🔴 SYSTEM: 禁止關閉資料庫' },
          { pattern: /\.shutdown\s*\(/i, code: 'SHUTDOWN_FUNC', message: '🔴 SYSTEM: 禁止關閉資料庫' },
          { pattern: /replSetReconfig\s*:/i, code: 'REPL_RECONFIG', message: '🔴 SYSTEM: 禁止重新設定 Replica Set' },
          { pattern: /replSetStepDown\s*:/i, code: 'REPL_STEPDOWN', message: '🔴 SYSTEM: 禁止強制降級 Primary' },
          { pattern: /setParameter\s*:/i, code: 'SET_PARAMETER', message: '🔴 SYSTEM: 禁止變更系統參數' }
        ]
      },

      // ========================================
      // 🟠 危險操作 - 可用 --allow-dangerous 放行
      // ========================================
      dangerous: {
        dataLoss: [
          { pattern: /\.drop\s*\(\s*\)/i, code: 'DROP_COLLECTION', message: '🟠 DATA LOSS: drop() 會刪除整個 Collection', suggestion: '確認真的要刪除，並確保有備份' },
          { pattern: /\.deleteMany\s*\(\s*\{\s*\}\s*\)/i, code: 'DELETE_ALL', message: '🟠 DATA LOSS: deleteMany({}) 會刪除所有文件', suggestion: '請加上查詢條件' },
          { pattern: /\.remove\s*\(\s*\{\s*\}\s*\)/i, code: 'REMOVE_ALL', message: '🟠 DATA LOSS: remove({}) 會刪除所有文件', suggestion: '請使用 deleteMany 並加上條件' }
        ],
        bulkOperation: [
          { pattern: /\.updateMany\s*\(\s*\{\s*\}\s*,/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: updateMany({}, ...) 會更新所有文件', suggestion: '請加上查詢條件' },
          { pattern: /\.replaceOne\s*\(/i, code: 'REPLACE_ONE', message: '🟠 DATA RISK: replaceOne 會完全取代文件', suggestion: '考慮使用 updateOne 搭配 $set' }
        ],
        schemaChange: [
          { pattern: /\.dropIndex\s*\(/i, code: 'DROP_INDEX', message: '🟠 PERFORMANCE: dropIndex 可能影響查詢效能', suggestion: '確認該索引已無查詢使用' },
          { pattern: /\.dropIndexes\s*\(/i, code: 'DROP_INDEXES', message: '🟠 PERFORMANCE: dropIndexes 會刪除所有索引', suggestion: '這是非常危險的操作' },
          { pattern: /\$rename\s*:/i, code: 'RENAME_FIELD', message: '🟠 BREAKING: $rename 可能破壞應用程式', suggestion: '確認所有應用程式都已更新欄位名稱' },
          { pattern: /\$unset\s*:/i, code: 'UNSET_FIELD', message: '🟠 DATA LOSS: $unset 會永久刪除欄位', suggestion: '確認該欄位已無使用' },
          { pattern: /\.renameCollection\s*\(/i, code: 'RENAME_COLLECTION', message: '🟠 BREAKING: renameCollection 可能破壞應用程式', suggestion: '確認所有應用程式都已更新 Collection 名稱' },
          { pattern: /renameCollection\s*:/i, code: 'RENAME_COLLECTION_CMD', message: '🟠 BREAKING: renameCollection 可能破壞應用程式', suggestion: '確認所有應用程式都已更新 Collection 名稱' }
        ],
        validation: [
          { pattern: /validationAction\s*:\s*['"]error['"]/i, code: 'VALIDATION_ERROR', message: '🟠 BREAKING: validationAction: "error" 可能導致寫入失敗', suggestion: '先使用 "warn" 測試' },
          { pattern: /validationLevel\s*:\s*['"]strict['"]/i, code: 'VALIDATION_STRICT', message: '🟠 BREAKING: validationLevel: "strict" 會驗證所有文件', suggestion: '確認現有資料都符合 schema' }
        ]
      },

      // ========================================
      // 🟡 警告提示 - 不阻擋執行
      // ========================================
      warnings: {
        operations: [
          { pattern: /\.createIndex\s*\(/i, message: '⚠️ createIndex 在大 Collection 上可能需要較長時間' },
          { pattern: /background\s*:\s*false/i, message: '⚠️ background: false 會阻塞操作' },
          { pattern: /\.aggregate\s*\(/i, message: '⚠️ aggregate 在大數據集上可能耗費大量資源' },
          { pattern: /\$lookup\s*:/i, message: '⚠️ $lookup 可能造成效能問題，確認有適當索引' },
          { pattern: /sparse\s*:\s*true/i, message: '⚠️ sparse index 不會包含 null 值的文件' },
          { pattern: /expireAfterSeconds\s*:/i, message: '⚠️ TTL index 會自動刪除過期文件' },
          { pattern: /\.deleteMany\s*\(/i, message: '⚠️ deleteMany 可能影響大量資料' },
          { pattern: /\.updateMany\s*\(/i, message: '⚠️ updateMany 可能影響大量資料' }
        ]
      }
    };
  }

  async connect() {
    try {
      // Set migrate-mongo config
      migrateMongo.config.set(this.config);
      
      // Connect using migrate-mongo's method
      const { db, client } = await migrateMongo.database.connect();
      this.db = db;
      this.client = client;
      
      return { db, client };
    } catch (error) {
      throw new Error(`MongoDB connection failed: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async status() {
    try {
      const statusResult = await migrateMongo.status(this.db);
      
      const pending = statusResult.filter(m => m.appliedAt === 'PENDING');
      const applied = statusResult.filter(m => m.appliedAt !== 'PENDING');
      
      return {
        pending: pending.map(m => m.fileName),
        applied: applied.map(m => ({
          fileName: m.fileName,
          appliedAt: m.appliedAt
        })),
        total: statusResult.length
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
      const migrated = await migrateMongo.up(this.db, this.client);
      result.applied = migrated;
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Run migration with sanity check
   * Supports preCheck and postCheck functions exported from migration files
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

    // Get pending migrations
    const statusResult = await migrateMongo.status(this.db);
    const pending = statusResult.filter(m => m.appliedAt === 'PENDING');

    if (pending.length === 0) {
      return result;
    }

    // Process each pending migration
    for (const migration of pending) {
      const filePath = path.join(this.config.migrationsDir, migration.fileName);
      
      try {
        // Dynamically import the migration file
        const migrationModule = await import(`file://${filePath}`);
        
        const context = {
          db: this.db,
          client: this.client,
          config: this.config
        };

        // Configure sanity checker for this migration
        const checker = new SanityChecker({
          enabled: true,
          autoRollback: this.config.sanityCheck?.autoRollback ?? true,
          timeoutMs: this.config.sanityCheck?.timeoutMs ?? 30000,
          verbose: options.verbose ?? this.config.sanityCheck?.verbose ?? true
        });

        // Run with sanity check if preCheck or postCheck are defined
        if (migrationModule.preCheck || migrationModule.postCheck) {
          console.log(`\n🔍 Running ${migration.fileName} with sanity checks...`);
          
          const sanityResult = await checker.runWithSanityCheck({
            up: async () => {
              await migrateMongo.up(this.db, this.client);
            },
            down: async () => {
              await migrateMongo.down(this.db, this.client);
            },
            preCheck: migrationModule.preCheck,
            postCheck: migrationModule.postCheck,
            context
          });

          result.sanityResults.push({
            file: migration.fileName,
            ...sanityResult
          });

          if (sanityResult.success) {
            result.applied.push(migration.fileName);
          } else {
            result.errors.push(`${migration.fileName}: ${sanityResult.error}`);
            if (!sanityResult.rolledBack) {
              break; // Stop processing if sanity check failed without rollback
            }
          }
        } else {
          // No sanity checks defined, run normally
          const migrated = await migrateMongo.up(this.db, this.client);
          if (migrated.length > 0) {
            result.applied.push(...migrated);
          }
          break; // migrate-mongo.up() processes all pending at once
        }
      } catch (error) {
        result.errors.push(`${migration.fileName}: ${error.message}`);
        break;
      }
    }

    return result;
  }

  async down(count = 1) {
    const result = {
      rolledBack: [],
      errors: []
    };

    try {
      for (let i = 0; i < count; i++) {
        const migrated = await migrateMongo.down(this.db, this.client);
        if (migrated.length === 0) break;
        result.rolledBack.push(...migrated);
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  async create(name) {
    try {
      const fileName = await migrateMongo.create(name);
      return fileName;
    } catch (error) {
      throw new Error(`Failed to create migration: ${error.message}`);
    }
  }

  async validate(options = {}) {
    const results = {
      valid: true,
      results: []
    };

    try {
      const migrationsDir = this.config.migrationsDir;
      const files = await fs.readdir(migrationsDir);
      const migrationFiles = files.filter(f => f.endsWith('.js'));

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

    // Extract up() and down() function bodies
    const upBody = this.extractFunctionBody(content, 'up');
    const downBody = this.extractFunctionBody(content, 'down');

    // === 1. Check for empty down() when up() has operations ===
    const upHasOperations = upBody.trim().length > 0 && 
      (this.containsOperation(upBody, 'createCollection') ||
       this.containsOperation(upBody, 'createIndex') ||
       this.containsOperation(upBody, 'insertMany') ||
       this.containsOperation(upBody, 'insertOne'));
    
    const downIsEmpty = !downBody.trim() || 
      downBody.trim() === '// BUG: Empty down() - no rollback!' ||
      !(/\w+\s*\.\s*\w+\s*\(/.test(downBody)); // No method calls
    
    if (upHasOperations && downIsEmpty) {
      errors.push({
        type: 'missing-down',
        operation: 'down()',
        message: 'down() is empty but up() contains operations - rollback missing!'
      });
    }

    // === 2. Extract created collections in up() ===
    const createdCollections = this.extractCreatedCollections(upBody);
    const droppedCollectionsInDown = this.extractDroppedCollections(downBody);
    const droppedCollectionsInUp = this.extractDroppedCollections(upBody);
    
    // === 3. Check for orphan drops in down() ===
    for (const dropped of droppedCollectionsInDown) {
      if (!createdCollections.includes(dropped)) {
        errors.push({
          type: 'orphan-drop',
          operation: 'drop',
          message: `Orphan drop: down() drops '${dropped}' but up() doesn't create it`
        });
      }
    }

    // === 3b. Check for orphan drops in up() ===
    for (const dropped of droppedCollectionsInUp) {
      if (!createdCollections.includes(dropped)) {
        errors.push({
          type: 'orphan-drop-in-up',
          operation: 'drop',
          message: `Orphan drop in up(): '${dropped}' is dropped but not created in this migration`
        });
      }
    }

    // === 4. Check for forbidden operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const rule of rules.forbidden[category]) {
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

    // === 5. Check for dangerous operations ===
    for (const category of Object.keys(rules.dangerous)) {
      for (const rule of rules.dangerous[category]) {
        // Special case: Allow 'drop' in down() for collections created in up()
        if (rule.code === 'DROP_COLLECTION') {
          const hasDropInDown = this.containsOperation(downBody, 'drop');
          const hasDropInUp = this.containsOperation(upBody, 'drop');
          
          if (hasDropInDown && !hasDropInUp) {
            const allDropsAreValid = droppedCollectionsInDown.every(c => createdCollections.includes(c));
            if (allDropsAreValid && droppedCollectionsInDown.length > 0) {
              warnings.push({
                type: 'allowed-drop-for-create',
                message: `✅ [ALLOWED] drop in down() for collections created in up()`
              });
              continue;
            }
          }
        }

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

    // === 6. Check for warning operations ===
    for (const rule of rules.warnings.operations) {
      if (rule.pattern.test(content)) {
        warnings.push({
          type: 'warning',
          message: rule.message
        });
      }
    }

    // Combine errors
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

  extractCreatedCollections(code) {
    const collections = [];
    // Match: createCollection('name') or createCollection("name")
    const regex = /createCollection\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      collections.push(match[1]);
    }
    return collections;
  }

  extractDroppedCollections(code) {
    const collections = [];
    // Match: collection('name').drop() or .collection("name").drop
    const regex = /collection\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*drop/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      collections.push(match[1]);
    }
    return collections;
  }

  extractFunctionBody(content, functionName) {
    const patterns = [
      // export async function up(db, client) { ... }
      new RegExp(`export\\s+async\\s+function\\s+${functionName}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)}(?=\\s*export|\\s*$)`, 'm'),
      // export const up = async (db, client) => { ... }
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*{([\\s\\S]*?)}\\s*;?`, 'm'),
      // async up(db, client) { ... }
      new RegExp(`async\\s+${functionName}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)}`, 'm'),
    ];
    
    for (const regex of patterns) {
      const match = content.match(regex);
      if (match) return match[1];
    }
    return '';
  }

  containsOperation(code, operation) {
    const patterns = [
      new RegExp(`\\.${operation}\\s*\\(`),           // .createUser(
      new RegExp(`\\['${operation}'\\]`),             // ['createUser']
      new RegExp(`\\["${operation}"\\]`),             // ["createUser"]
      new RegExp(`db\\.${operation}`),                // db.createUser
      new RegExp(`${operation}\\s*:\\s*['"]`),        // createUser: 'name' (in db.command)
      new RegExp(`${operation}\\s*:\\s*[\\w$]`),      // createUser: variableName
    ];
    return patterns.some(p => p.test(code));
  }
}

export default MongoDBAdapter;
