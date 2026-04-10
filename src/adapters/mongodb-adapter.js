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
    this.changelogCollection = config.changelogCollection || 'changelog';
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
  getValidationRules(mode = 'versioned') {
    const isRepeatable = mode === 'repeatable';
    return {
      // ========================================
      // 🔴 絕對禁止 - 預設無法放行 (需 --allow-forbidden)
      // ========================================
      forbidden: {
        database: [
          { pattern: /\.dropDatabase\s*\(/i, code: 'DROP_DATABASE', message: '🔴 DATA LOSS: Drop database is forbidden / 禁止刪除資料庫' },
          { pattern: /dropDatabase\s*:\s*(?:true|1)/i, code: 'DROP_DATABASE_CMD', message: '🔴 DATA LOSS: Drop database is forbidden / 禁止刪除資料庫' }
        ],
        // DCL mode: forbid DDL schema changes (must live in DDL versioned project)
        // DDL mode: forbid user/role management (must live in DCL repeatable project)
        ...(isRepeatable ? {
          // DDL structural operations — absolutely not allowed in DCL (no bypass)
          dclReverse: [
            { pattern: /\.createCollection\s*\(/i,   code: 'CREATE_COLLECTION_IN_DCL',      message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /\.createIndex(?:es)?\s*\(/i, code: 'CREATE_INDEX_IN_DCL',           message: '🔴 DDL: Index management should be in DDL project (Versioned) / 索引管理應在 DDL 專案' },
            { pattern: /\.renameCollection\s*\(/i,   code: 'RENAME_COLLECTION_IN_DCL',      message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' },
            { pattern: /renameCollection\s*:/i,      code: 'RENAME_COLLECTION_IN_DCL_CMD',  message: '🔴 DDL: Schema changes should be in DDL project (Versioned) / 結構變更應在 DDL 專案' }
          ],
          // High-risk DCL ops: irreversible or credential-sensitive — require // @allow-forbidden: true
          dclHighRisk: [
            { pattern: /\.dropUser\s*\(/i,   code: 'DROP_USER',       message: '🔴 DCL HIGH RISK: dropUser is irreversible, requires // @allow-forbidden: true / dropUser 為不可逆操作，需加 annotation 審批' },
            { pattern: /dropUser\s*:/i,      code: 'DROP_USER_CMD',   message: '🔴 DCL HIGH RISK: dropUser is irreversible, requires // @allow-forbidden: true / dropUser 為不可逆操作，需加 annotation 審批' },
            { pattern: /\.updateUser\s*\(/i, code: 'UPDATE_USER',     message: '🔴 DCL HIGH RISK: updateUser (including password change) requires // @allow-forbidden: true / 更新使用者（含密碼變更）需加 annotation 審批' },
            { pattern: /updateUser\s*:/i,    code: 'UPDATE_USER_CMD', message: '🔴 DCL HIGH RISK: updateUser (including password change) requires // @allow-forbidden: true / 更新使用者（含密碼變更）需加 annotation 審批' }
          ]
        } : {
          dcl: [
          { pattern: /\.createUser\s*\(/i, code: 'CREATE_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /createUser\s*:/i, code: 'CREATE_USER_CMD', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\.dropUser\s*\(/i, code: 'DROP_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /dropUser\s*:/i, code: 'DROP_USER_CMD', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\.updateUser\s*\(/i, code: 'UPDATE_USER', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /updateUser\s*:/i, code: 'UPDATE_USER_CMD', message: '🔴 DCL: User management should be in DCL project (Repeatable) / 使用者管理應在 DCL 專案' },
          { pattern: /\.grantRolesToUser\s*\(/i, code: 'GRANT_ROLES', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /grantRolesToUser\s*:/i, code: 'GRANT_ROLES_CMD', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /\.revokeRolesFromUser\s*\(/i, code: 'REVOKE_ROLES', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /revokeRolesFromUser\s*:/i, code: 'REVOKE_ROLES_CMD', message: '🔴 DCL: Permission management should be in DCL project (Repeatable) / 權限管理應在 DCL 專案' },
          { pattern: /\.createRole\s*\(/i, code: 'CREATE_ROLE', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' },
          { pattern: /createRole\s*:/i, code: 'CREATE_ROLE_CMD', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' },
          { pattern: /\.dropRole\s*\(/i, code: 'DROP_ROLE', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' },
          { pattern: /dropRole\s*:/i, code: 'DROP_ROLE_CMD', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' },
          { pattern: /\.updateRole\s*\(/i, code: 'UPDATE_ROLE', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' },
          { pattern: /updateRole\s*:/i, code: 'UPDATE_ROLE_CMD', message: '🔴 DCL: Role management should be in DCL project (Repeatable) / 角色管理應在 DCL 專案' }
          ]
        }),
        system: [
          { pattern: /shutdown\s*:\s*(?:true|1)/i, code: 'SHUTDOWN', message: '🔴 SYSTEM: Shutdown database is forbidden / 禁止關閉資料庫' },
          { pattern: /\.shutdown\s*\(/i, code: 'SHUTDOWN_FUNC', message: '🔴 SYSTEM: Shutdown database is forbidden / 禁止關閉資料庫' },
          { pattern: /replSetReconfig\s*:/i, code: 'REPL_RECONFIG', message: '🔴 SYSTEM: Replica Set reconfig is forbidden / 禁止重新設定 Replica Set' },
          { pattern: /replSetStepDown\s*:/i, code: 'REPL_STEPDOWN', message: '🔴 SYSTEM: Force stepdown Primary is forbidden / 禁止強制降級 Primary' },
          { pattern: /setParameter\s*:/i, code: 'SET_PARAMETER', message: '🔴 SYSTEM: Change system parameters is forbidden / 禁止變更系統參數' }
        ]
      },

      // ========================================
      // 🟠 危險操作 - 可用 --allow-dangerous 放行
      // ========================================
      dangerous: {
        dataLoss: [
          { pattern: /\.drop\s*\(\s*\)/i, code: 'DROP_COLLECTION', message: '🟠 DATA LOSS: drop() will delete entire collection / 會刪除整個 Collection', suggestion: 'Confirm deletion and ensure backup exists / 確認真的要刪除，並確保有備份' },
          { pattern: /\.deleteMany\s*\(\s*\{\s*\}\s*\)/i, code: 'DELETE_ALL', message: '🟠 DATA LOSS: deleteMany({}) will delete all documents / 會刪除所有文件', suggestion: 'Add query condition / 請加上查詢條件' },
          { pattern: /\.remove\s*\(\s*\{\s*\}\s*\)/i, code: 'REMOVE_ALL', message: '🟠 DATA LOSS: remove({}) will delete all documents / 會刪除所有文件', suggestion: 'Use deleteMany with query condition / 請使用 deleteMany 並加上條件' }
        ],
        bulkOperation: [
          { pattern: /\.updateMany\s*\(\s*\{\s*\}\s*,/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: updateMany({}, ...) will update all documents / 會更新所有文件', suggestion: 'Add query condition / 請加上查詢條件' },
          { pattern: /\.replaceOne\s*\(/i, code: 'REPLACE_ONE', message: '🟠 DATA RISK: replaceOne will completely replace document / 會完全取代文件', suggestion: 'Consider using updateOne with $set / 考慮使用 updateOne 搭配 $set' }
        ],
        schemaChange: [
          { pattern: /\.dropIndex\s*\(/i, code: 'DROP_INDEX', message: '🟠 PERFORMANCE: dropIndex may affect query performance / 可能影響查詢效能', suggestion: 'Confirm index is no longer used / 確認該索引已無查詢使用' },
          { pattern: /\.dropIndexes\s*\(/i, code: 'DROP_INDEXES', message: '🟠 PERFORMANCE: dropIndexes will delete all indexes / 會刪除所有索引', suggestion: 'This is a very dangerous operation / 這是非常危險的操作' },
          { pattern: /\$rename\s*:/i, code: 'RENAME_FIELD', message: '🟠 BREAKING: $rename may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated field names / 確認所有應用程式都已更新欄位名稱' },
          { pattern: /\$unset\s*:/i, code: 'UNSET_FIELD', message: '🟠 DATA LOSS: $unset will permanently delete field / 會永久刪除欄位', suggestion: 'Confirm field is no longer used / 確認該欄位已無使用' },
          { pattern: /\.renameCollection\s*\(/i, code: 'RENAME_COLLECTION', message: '🟠 BREAKING: renameCollection may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated collection name / 確認所有應用程式都已更新 Collection 名稱' },
          { pattern: /renameCollection\s*:/i, code: 'RENAME_COLLECTION_CMD', message: '🟠 BREAKING: renameCollection may break applications / 可能破壞應用程式', suggestion: 'Confirm all apps have updated collection name / 確認所有應用程式都已更新 Collection 名稱' }
        ],
        validation: [
          { pattern: /validationAction\s*:\s*['"]error['"]/i, code: 'VALIDATION_ERROR', message: '🟠 BREAKING: validationAction "error" may cause write failures / 可能導致寫入失敗', suggestion: 'Test with "warn" first / 先使用 "warn" 測試' },
          { pattern: /validationLevel\s*:\s*['"]strict['"]/i, code: 'VALIDATION_STRICT', message: '🟠 BREAKING: validationLevel "strict" validates all documents / 會驗證所有文件', suggestion: 'Confirm existing data matches schema / 確認現有資料都符合 schema' }
        ]
      },

      // ========================================
      // 🟡 警告提示 - 不阻擋執行
      // ========================================
      warnings: {
        operations: [
          { pattern: /\.createIndex\s*\(/i, message: '⚠️ createIndex may take long on large collections / 在大 Collection 上可能需要較長時間' },
          { pattern: /background\s*:\s*false/i, message: '⚠️ background: false will block operations / 會阻塞操作' },
          { pattern: /\.aggregate\s*\(/i, message: '⚠️ aggregate may consume lots of resources on large datasets / 在大數據集上可能耗費大量資源' },
          { pattern: /\$lookup\s*:/i, message: '⚠️ $lookup may cause performance issues, ensure proper indexes / 可能造成效能問題，確認有適當索引' },
          { pattern: /sparse\s*:\s*true/i, message: '⚠️ sparse index excludes documents with null values / 不會包含 null 值的文件' },
          { pattern: /expireAfterSeconds\s*:/i, message: '⚠️ TTL index will auto-delete expired documents / 會自動刪除過期文件' },
          { pattern: /\.deleteMany\s*\(/i, message: '⚠️ deleteMany may affect large amounts of data / 可能影響大量資料' },
          { pattern: /\.updateMany\s*\(/i, message: '⚠️ updateMany may affect large amounts of data / 可能影響大量資料' }
        ]
      },

      // ========================================
      // 🟡 可疑名稱檢測 - 識別符包含危險關鍵字
      // ========================================
      suspiciousNames: {
        keywords: [
          'dropdatabase', 'drop_database', 'dropdb',
          'deleteall', 'delete_all', 'removeall', 'remove_all',
          'shutdown', 'createuser', 'create_user', 'dropuser', 'drop_user',
          'grantrole', 'grant_role', 'revokerole', 'revoke_role'
        ],
        message: '⚠️ SUSPICIOUS NAME: Identifier contains dangerous keyword which may cause false positive/negative detection'
      },

      // ========================================
      // 🔶 效能檢測 - Performance Checks
      // ========================================
      performance: {
        thresholds: {
          maxQueryLength: this.config?.performance?.thresholds?.maxQueryLength ?? 5000,
          maxTotalLength: this.config?.performance?.thresholds?.maxTotalLength ?? 50000,
          maxIndexesPerMigration: this.config?.performance?.thresholds?.maxIndexesPerMigration ?? 5,
          maxBulkOpsPerMigration: this.config?.performance?.thresholds?.maxBulkOpsPerMigration ?? 10,
          maxStatementsPerMigration: this.config?.performance?.thresholds?.maxStatementsPerMigration ?? 50,
          maxLookupStages: this.config?.performance?.thresholds?.maxLookupStages ?? 3,
          maxPipelineStages: this.config?.performance?.thresholds?.maxPipelineStages ?? 10
        },
        messages: {
          migrationTooLong: '🔶 PERFORMANCE: Migration file is very long ({length} chars), consider splitting / Migration 檔案過長 ({length} 字元)，建議拆分',
          tooManyIndexes: '🔶 PERFORMANCE: Creating {count} indexes in one migration may cause long lock time / 單次建立 {count} 個索引可能造成長時間鎖定',
          tooManyBulkOps: '🔶 PERFORMANCE: {count} bulk operations in one migration may cause performance issues / 單次 {count} 個 bulk 操作可能影響效能',
          tooManyStatements: '🔶 PERFORMANCE: {count} statements in one migration, consider splitting / 單次 {count} 個語句，建議拆分',
          multipleIndexOnSameCollection: '🔶 PERFORMANCE: Multiple indexes on collection "{collection}" in same migration, consider combining / 同一 migration 對 "{collection}" 建立多個索引，建議合併',
          tooManyLookups: '🔶 PERFORMANCE: Aggregate has {count} $lookup stages, may be slow / Aggregate 有 {count} 個 $lookup，可能很慢',
          tooManyPipelineStages: '🔶 PERFORMANCE: Aggregate has {count} pipeline stages, consider simplifying / Aggregate 有 {count} 個 stages，建議簡化',
          noIndexHint: '🔶 PERFORMANCE: Query without index hint on large collection may be slow / 大 Collection 的查詢沒有 index hint 可能很慢',
          unboundedFind: '🔶 PERFORMANCE: find() without limit() may return too many documents / find() 沒有 limit() 可能返回過多文件',
          sortWithoutIndex: '🔶 PERFORMANCE: sort() without proper index may cause in-memory sort / sort() 沒有適當索引可能造成記憶體排序'
        }
      }
    };
  }

  async connect() {
    try {
      // Set migrate-mongo config
      // migrate-mongo expects 'changelogCollectionName', map from our 'changelogCollection'
      const migrateMongoConfig = {
        ...this.config,
        changelogCollectionName: this.config.changelogCollection || this.config.changelogCollectionName || 'changelog'
      };
      migrateMongo.config.set(migrateMongoConfig);
      
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
      // DCL/repeatable mode uses checksumCollection, not the DDL changelog collection.
      // Return empty DDL status — use `dcl:status` for DCL migration status.
      if (this.config.mode === 'repeatable') {
        return { pending: [], applied: [], total: 0 };
      }

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

  /**
   * Get list of migration files
   */
  async getMigrationFiles() {
    const migrationsDir = this.config.migrationsDir;
    const files = await fs.readdir(migrationsDir);
    return files.filter(f => f.endsWith('.js')).sort();
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
      for (const fileName of files) {
        try {
          // Check if already exists
          const existing = await this.db.collection(this.changelogCollection).findOne({ fileName });
          if (existing) {
            continue; // Already marked
          }
          
          await this.db.collection(this.changelogCollection).insertOne({
            fileName,
            appliedAt: new Date()
          });
          result.marked.push(fileName);
        } catch (error) {
          result.errors.push(`${fileName}: ${error.message}`);
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
      // Get status to filter migrations
      const statusResult = await migrateMongo.status(this.db);
      let pending = statusResult.filter(m => m.appliedAt === 'PENDING').map(m => m.fileName);
      
      // Filter by target (up to and including)
      if (options.target) {
        const targetIndex = pending.findIndex(f => 
          f === options.target || f.includes(options.target)
        );
        if (targetIndex === -1) {
          result.errors.push(`Target migration not found: ${options.target}`);
          return result;
        }
        pending = pending.slice(0, targetIndex + 1);
      }
      
      // Filter by only (specific migration)
      if (options.only) {
        const onlyFile = pending.find(f => 
          f === options.only || f.includes(options.only)
        );
        if (!onlyFile) {
          result.errors.push(`Migration not found in pending: ${options.only}`);
          return result;
        }
        pending = [onlyFile];
      }
      
      // Run migrations one by one to respect filters
      for (const fileName of pending) {
        try {
          const filePath = path.join(this.config.migrationsDir, fileName);
          const migrationModule = await import(`file://${filePath}?t=${Date.now()}`);
          
          // Run the up function
          await migrationModule.up(this.db, this.client);
          
          // Record in changelog
          await this.db.collection(this.changelogCollection).insertOne({
            fileName,
            appliedAt: new Date()
          });
          
          result.applied.push(fileName);
        } catch (error) {
          result.errors.push(`${fileName}: ${error.message}`);
          break;
        }
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Run migration with sanity check
   * Supports preCheck and postCheck functions exported from migration files
   * 
   * @param {Object} migrationOrOptions - Migration object or options
   * @param {Object} [options] - Options when first param is migration
   * @returns {Promise<Object>}
   */
  async upWithSanityCheck(migrationOrOptions = {}, options = {}) {
    // Check if first parameter is a migration object with up/down
    if (migrationOrOptions.up && typeof migrationOrOptions.up === 'function') {
      // Direct migration object passed (test mode)
      return await this._runSingleMigrationWithSanityCheck(migrationOrOptions, options);
    }
    
    // Otherwise, it's options for batch migration
    const batchOptions = migrationOrOptions;
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

  /**
   * Run a single migration with sanity check (for test mode)
   * @private
   */
  async _runSingleMigrationWithSanityCheck(migration, options = {}) {
    const context = {
      db: this.db,
      client: this.client,
      config: this.config
    };

    const localAutoRollback = options.autoRollback !== undefined 
      ? options.autoRollback 
      : (this.config.sanityCheck?.autoRollback ?? true);

    const checker = new SanityChecker({
      enabled: true,
      autoRollback: localAutoRollback,
      timeout: this.config.sanityCheck?.timeout ?? 30000,
      timeoutMs: this.config.sanityCheck?.timeoutMs ?? 30000,
      verbose: options.verbose ?? this.config.sanityCheck?.verbose ?? false
    });

    return await checker.runWithSanityCheck(migration, context, { autoRollback: localAutoRollback });
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

      // Enrich generated template with sanity check scaffolding for better authoring parity.
      const filePath = path.join(this.config.migrationsDir, fileName);
      const dbName = this.config.mongodb?.databaseName || this.config.mongodb?.database || 'mydb';
      const template = `/**
 * Migration: ${name}
 * File: ${fileName}
 * Created: ${new Date().toISOString()}
 */

export async function preCheck(db, client) {
  // Example: ensure preconditions before migration
  // const exists = await db.listCollections({ name: 'your_collection' }).hasNext();
  // if (exists) return { success: false, error: 'Collection already exists' };
  return { success: true, details: ['Pre-check passed'] };
}

export async function up(db, client) {
  // Your migration logic here
  // Example:
  // await db.createCollection('example');
}

export async function postCheck(db, client) {
  // Example: validate migration result
  // const exists = await db.listCollections({ name: 'example' }).hasNext();
  // if (!exists) return { success: false, error: 'Collection not found after migration' };
  return { success: true, details: ['Post-check passed on ${dbName}'] };
}

export async function down(db, client) {
  // Rollback logic for versioned migrations
  // Example:
  // await db.collection('example').drop();
}
`;

      try {
        await fs.access(filePath);
        await fs.writeFile(filePath, template);
      } catch (err) {
        // Some test mocks or migrate-mongo versions may not create files immediately.
        if (err.code !== 'ENOENT') throw err;
      }

      return fileName;
    } catch (error) {
      throw new Error(`Failed to create migration: ${error.message}`);
    }
  }

  /**
   * Create a new DCL (Repeatable) migration file with R__ prefix
   * @param {string} name - Migration name
   * @param {string} sequenceNumber - Optional sequence number (e.g., '001', '002')
   * @returns {Promise<string>} - Created file name
   */
  async createDCL(name, sequenceNumber = '') {
    // Generate filename: R__001_name.js or R__name.js
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const prefix = sequenceNumber ? `R__${sequenceNumber}_` : 'R__';
    const fileName = `${prefix}${sanitizedName}.js`;
    const filePath = path.join(this.config.migrationsDir, fileName);

    // Check if file already exists
    try {
      await fs.access(filePath);
      throw new Error(`DCL migration file already exists: ${fileName}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const dbName = this.config.mongodb?.database || 'mydb';
    const template = `/**
 * DCL Repeatable Migration: ${name}
 * File: ${fileName}
 * Created: ${new Date().toISOString()}
 * 
 * ⚠️  IMPORTANT: This script must be IDEMPOTENT!
 * It will run whenever the checksum changes.
 * Always check existence before creating users/roles!
 */

export async function up(db, client) {
  const adminDb = client.db('admin');

  // Optional pre-check before applying DCL changes.
  // Return { success: false, error: 'reason' } to stop execution.
  // This is executed only when running with sanity-check workflow.
  // export async function preCheck(db, client) { ... }
  
  // Example: Create user if not exists
  // try {
  //   const users = await adminDb.command({ usersInfo: 'app_readonly' });
  //   if (users.users.length === 0) {
  //     await adminDb.command({
  //       createUser: 'app_readonly',
  //       pwd: 'password',
  //       roles: [{ role: 'read', db: '${dbName}' }]
  //     });
  //     console.log('[DCL] Created app_readonly user');
  //   } else {
  //     // Update existing user's roles (idempotent)
  //     await adminDb.command({
  //       updateUser: 'app_readonly',
  //       roles: [{ role: 'read', db: '${dbName}' }]
  //     });
  //     console.log('[DCL] Updated app_readonly user roles');
  //   }
  // } catch (error) {
  //   console.error('[DCL] Error managing user:', error.message);
  //   throw error;
  // }
  
  // Your DCL statements here:
  
}

export async function preCheck(db, client) {
  // Example: ensure admin DB is reachable before DCL changes
  // await client.db('admin').command({ ping: 1 });
  return { success: true, details: ['Pre-check passed'] };
}

export async function postCheck(db, client) {
  // Example: verify user/role state after DCL changes
  // const info = await client.db('admin').command({ usersInfo: 'app_readonly' });
  // if (!info.users?.length) return { success: false, error: 'User not found after migration' };
  return { success: true, details: ['Post-check passed on ${dbName}'] };
}

// Note: DCL migrations typically don't need down()
// Permission changes should be managed forward-only
export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
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
   * Parse per-file allow annotations from JS comments at the top of the file.
   * Supports:
   *   // @allow-dangerous: true
   *   // @allow: CODE1,CODE2
   *   // @allow-forbidden: true
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
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('/*') || t.startsWith('*')) continue;
      if (!t.startsWith('//')) break;
      const dangerousMatch = t.match(/\/\/\s*@allow-dangerous\s*:\s*(.+)/i);
      if (dangerousMatch) {
        const v = dangerousMatch[1].trim().toLowerCase();
        annotations.allowDangerous = ['true', 'yes', '1'].includes(v);
      }
      const forbiddenMatch = t.match(/\/\/\s*@allow-forbidden\s*:\s*(.+)/i);
      if (forbiddenMatch) {
        const v = forbiddenMatch[1].trim().toLowerCase();
        annotations.allowForbidden = ['true', 'yes', '1'].includes(v);
      }
      const allowMatch = t.match(/\/\/\s*@allow\s*:\s*(.+)/i);
      if (allowMatch) {
        const codes = allowMatch[1].split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
        annotations.allowedCodes.push(...codes);
      }
    }
    return annotations;
  }

  /**
   * Check whether a migration file exports a function by name.
   * Supports function declarations and const-assigned async arrows.
   * @param {string} content
   * @param {string} functionName
   * @returns {boolean}
   */
  hasExportedFunction(content, functionName) {
    const patterns = [
      new RegExp(`export\\s+async\\s+function\\s+${functionName}\\s*\\(`),
      new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`),
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*async\\s*\\(`),
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*\\(`)
    ];
    return patterns.some(p => p.test(content));
  }

  /**
   * Validate JS syntax and required migration exports.
   * @param {string} content
   * @param {string} fileName
   * @returns {{errors: Array, warnings: Array}}
   */
  validateJSSyntax(content, fileName) {
    const errors = [];
    const warnings = [];

    if (!content || !content.trim()) {
      return { errors, warnings };
    }

    // Strip ESM export/import syntax and parse as a function body to catch syntax errors early.
    const parseTarget = content
      .replace(/^\s*import\s+.*?;?\s*$/gm, '')
      .replace(/^\s*export\s+default\s+/gm, '')
      .replace(/^\s*export\s+(async\s+function|function|const|let|var|class)\s+/gm, '$1 ')
      .replace(/^\s*export\s*\{\s*[^}]+\s*\};?\s*$/gm, '');

    try {
      // eslint-disable-next-line no-new-func
      new Function(parseTarget);
    } catch (error) {
      errors.push({
        type: 'syntax-error',
        code: 'JS_SYNTAX_ERROR',
        message: `🔴 JavaScript syntax error: ${error.message}`
      });
      return { errors, warnings };
    }

    const hasUp = this.hasExportedFunction(content, 'up');
    const hasDown = this.hasExportedFunction(content, 'down');

    if (!hasUp) {
      errors.push({
        type: 'missing-up-export',
        code: 'MISSING_UP_EXPORT',
        message: '🔴 Migration must export up() function'
      });
    }

    if (this.config.mode !== 'repeatable' && !hasDown) {
      errors.push({
        type: 'missing-down-export',
        code: 'MISSING_DOWN_EXPORT',
        message: '🔴 Versioned migration must export down() function'
      });
    }

    if (this.config.mode === 'repeatable' && !hasDown) {
      warnings.push({
        type: 'down-optional',
        message: '⚠️ down() is optional in repeatable (DCL) mode'
      });
    }

    return { errors, warnings };
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
    // === Parse per-file annotations (// @allow-dangerous: true / // @allow: CODE1,CODE2) ===
    const fileAnnotations = this.parseFileAnnotations(content, fileName);
    // Merge: per-file annotations can escalate permissions, but cannot downgrade CLI flags
    const effectiveOptions = {
      ...options,
      allowDangerous: options.allowDangerous || fileAnnotations.allowDangerous,
      allowForbidden: options.allowForbidden || fileAnnotations.allowForbidden,
      allowedCodes: [...(options.allowedCodes || []), ...(fileAnnotations.allowedCodes || [])]
    };
    options = effectiveOptions;

    const syntaxResult = this.validateJSSyntax(content, fileName);
    const errors = [...syntaxResult.errors];
    const warnings = [...syntaxResult.warnings];
    const dangerousOps = [];
    const forbiddenOps = [];
    const rules = this.getValidationRules(this.config.mode);

    // Normalize content for pattern matching (remove comments, collapse whitespace)
    const normalizedContent = this.normalizeJS(content);

    // Extract up() and down() function bodies
    const upBody = this.extractFunctionBody(content, 'up');
    const downBody = this.extractFunctionBody(content, 'down');
    
    // Normalize function bodies
    const normalizedUpBody = this.normalizeJS(upBody);
    const normalizedDownBody = this.normalizeJS(downBody);

    // === 1. DDL only: Check for empty down() (R__ repeatable files have no down()) ===
    if (this.config.mode !== 'repeatable' && this.hasExportedFunction(content, 'down')) {
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
    }

    // === 2. Extract created collections in up() ===
    const createdCollections = this.extractCreatedCollections(upBody);
    const droppedCollectionsInDown = this.extractDroppedCollections(downBody);
    const droppedCollectionsInUp = this.extractDroppedCollections(upBody);
    
    // === 3. DDL only: Check for orphan drops in down() (R__ repeatable files have no up/down) ===
    if (this.config.mode !== 'repeatable') {
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
    }

    // === 4. Check for forbidden operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const rule of rules.forbidden[category]) {
        // Smart allowance: dropDatabase in down() when up() creates database
        if (rule.code === 'DROP_DATABASE' || rule.code === 'DROP_DATABASE_CMD') {
          const hasDropDBInDown = /dropDatabase/i.test(normalizedDownBody);
          const hasDropDBInUp = /dropDatabase/i.test(normalizedUpBody);
          const hasDBInitInUp = /createCollection|_db_metadata/i.test(normalizedUpBody);
          
          // Allow dropDatabase only in down() when up() initializes database
          if (hasDropDBInDown && !hasDropDBInUp && hasDBInitInUp) {
            warnings.push({
              type: 'allowed-drop-database',
              message: `✅ [ALLOWED] dropDatabase in down() because up() initializes database`
            });
            continue;
          }
          
          // Forbid dropDatabase in up() unless explicitly approved via @allow-forbidden
          if (hasDropDBInUp) {
            const isAllowed = options.allowForbidden ||
              (options.allowedCodes && options.allowedCodes.includes(rule.code));
            if (isAllowed) {
              warnings.push({
                type: 'forbidden-allowed',
                code: rule.code,
                message: `⚠️ [FORCE ALLOWED] ${rule.message} (in up() function — EXPLICIT APPROVAL)`
              });
            } else {
              forbiddenOps.push({
                type: `forbidden-${category}`,
                code: rule.code,
                message: rule.message + ' (in up() function)'
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

    // === 5. Check for dangerous operations ===
    for (const category of Object.keys(rules.dangerous)) {
      for (const rule of rules.dangerous[category]) {
        // Special case (DDL only): Allow 'drop' in down() for collections created in up()
        if (rule.code === 'DROP_COLLECTION' && this.config.mode !== 'repeatable') {
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

        // Use UP section for pattern matching (DOWN rollback ops are expected to be destructive).
        // Find where down() starts and only scan content before it.
        const downStart = content.search(/\bexport\s+async\s+function\s+down\b|\bexport\s+const\s+down\s*=|\basync\s+down\s*\(/);
        const upOnlyContent = downStart > 0 ? content.slice(0, downStart) : content;
        const dangerousCheckTarget = this.normalizeJS(upOnlyContent);
        if (rule.pattern.test(dangerousCheckTarget)) {
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
      // Use normalized content for pattern matching
      if (rule.pattern.test(normalizedContent)) {
        warnings.push({
          type: 'warning',
          message: rule.message
        });
      }
    }

    // === 7. Check for suspicious identifier names ===
    const suspiciousNames = this.checkSuspiciousNames(content);
    for (const suspicious of suspiciousNames) {
      warnings.push(suspicious);
    }

    // === 8. Check for performance issues ===
    const performanceResult = this.checkPerformanceIssues(content, fileName);
    for (const perfWarning of performanceResult.warnings) {
      warnings.push(perfWarning);
    }

    // Combine errors
    const allErrors = [...errors, ...forbiddenOps, ...dangerousOps];

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings,
      forbiddenOps,
      dangerousOps,
      suspiciousNames,
      performanceIssues: performanceResult.warnings,
      performanceMetrics: performanceResult.metrics,
      summary: {
        forbidden: forbiddenOps.length,
        dangerous: dangerousOps.length,
        warnings: warnings.length,
        structural: errors.length,
        suspiciousNames: suspiciousNames.length,
        performanceIssues: performanceResult.warnings.length
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
    // Match: collection('name').drop() — but NOT dropIndex(), dropIndexes(), etc.
    // Uses \( \) to ensure we only match .drop() with empty parens.
    const regex = /collection\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*drop\s*\(\s*\)/g;
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

  /**
   * Normalize JavaScript content for pattern matching
   * - Remove string literals to avoid false positives from data values
   * - Remove single-line comments (// ...)
   * - Remove multi-line comments (/* ... *\/)
   * - Collapse multiple whitespace/newlines to single space
   * 
   * @param {string} js - Raw JavaScript content
   * @returns {string} - Normalized JavaScript
   */
  normalizeJS(js) {
    if (!js) return '';
    return js
      // Remove zero-width characters (Unicode confusion attack prevention)
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      // Convert fullwidth characters to halfwidth (Unicode normalization)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      // Remove template literals (backticks) - replace with placeholder
      .replace(/`(?:[^`\\]|\\.)*`/g, "'__STRING__'")
      // Remove string literals (single quotes) to avoid false positives
      .replace(/'(?:[^'\\]|\\.)*'/g, "'__STRING__'")
      // Remove string literals (double quotes)
      .replace(/"(?:[^"\\]|\\.)*"/g, '"__STRING__"')
      // Remove single-line comments (but not URLs like http://)
      .replace(/(?<!:)\/\/.*$/gm, ' ')
      // Remove multi-line comments /* ... */
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Collapse multiple whitespace/newlines to single space
      .replace(/\s+/g, ' ')
      // Trim
      .trim();
  }

  /**
   * Extract identifiers (collection names, variable names) from JavaScript for suspicious name checking
   * @param {string} js - JavaScript content
   * @returns {string[]} - Array of identifiers found
   */
  extractIdentifiers(js) {
    if (!js) return [];
    const identifiers = [];
    
    // Match collection names: collection('name') or collection("name")
    const collectionRegex = /\.collection\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = collectionRegex.exec(js)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Match createCollection('name')
    const createCollRegex = /createCollection\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = createCollRegex.exec(js)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Match index names: createIndex({}, {name: 'indexName'})
    const indexNameRegex = /name\s*:\s*['"]([^'"]+)['"]/g;
    while ((match = indexNameRegex.exec(js)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Match variable declarations: const varName = or let varName =
    const varRegex = /(?:const|let|var)\s+(\w+)\s*=/g;
    while ((match = varRegex.exec(js)) !== null) {
      identifiers.push(match[1]);
    }
    
    // Match destructured variable names: const { name1, name2 } = require(...)
    const destructureRegex = /(?:const|let|var)\s*\{\s*([^}]+)\}/g;
    while ((match = destructureRegex.exec(js)) !== null) {
      const vars = match[1].split(',').map(v => v.trim().split(/\s+as\s+|:/)[0].trim());
      identifiers.push(...vars.filter(v => v && /^\w+$/.test(v)));
    }
    
    return [...new Set(identifiers)]; // Remove duplicates
  }

  /**
   * Check for suspicious identifier names that may cause confusion
   * @param {string} js - JavaScript content
   * @returns {Object[]} - Array of warnings for suspicious names
   */
  checkSuspiciousNames(js) {
    const rules = this.getValidationRules();
    const warnings = [];
    const identifiers = this.extractIdentifiers(js);
    
    for (const identifier of identifiers) {
      const lowerName = identifier.toLowerCase().replace(/[_-]/g, '');
      for (const keyword of rules.suspiciousNames.keywords) {
        const normalizedKeyword = keyword.replace(/[_-]/g, '');
        if (lowerName.includes(normalizedKeyword)) {
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
   * Check for performance issues in JavaScript migration content
   * @param {string} js - JavaScript content  
   * @param {string} fileName - File name for context
   * @returns {Object} - Performance analysis result
   */
  checkPerformanceIssues(js, fileName = '') {
    const rules = this.getValidationRules();
    const thresholds = rules.performance.thresholds;
    const messages = rules.performance.messages;
    const warnings = [];
    const metrics = {};

    if (!js) {
      return { warnings, metrics };
    }

    // Helper to replace all occurrences
    const replaceAll = (str, search, replacement) => str.split(search).join(replacement);

    // 1. Check total migration length
    metrics.totalLength = js.length;
    if (js.length > thresholds.maxTotalLength) {
      warnings.push({
        type: 'performance-migration-length',
        code: 'MIGRATION_TOO_LONG',
        message: replaceAll(messages.migrationTooLong, '{length}', js.length),
        value: js.length,
        threshold: thresholds.maxTotalLength
      });
    }

    // 2. Count createIndex operations
    const indexMatches = js.match(/\.createIndex\s*\(/g) || [];
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

    // 3. Check for multiple indexes on same collection
    const indexesByCollection = {};
    const indexRegex = /\.collection\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*createIndex/g;
    let indexMatch;
    while ((indexMatch = indexRegex.exec(js)) !== null) {
      const collName = indexMatch[1];
      if (!indexesByCollection[collName]) {
        indexesByCollection[collName] = 0;
      }
      indexesByCollection[collName]++;
    }

    for (const [collection, count] of Object.entries(indexesByCollection)) {
      if (count > 1) {
        warnings.push({
          type: 'performance-multiple-indexes-same-collection',
          code: 'MULTIPLE_INDEXES_SAME_COLLECTION',
          message: replaceAll(messages.multipleIndexOnSameCollection, '{collection}', collection),
          collection,
          count
        });
      }
    }

    // 4. Count bulk operations (insertMany, updateMany, deleteMany, bulkWrite)
    const bulkOps = (js.match(/\.(insertMany|updateMany|deleteMany|bulkWrite)\s*\(/g) || []).length;
    metrics.bulkOpsCount = bulkOps;

    if (bulkOps > thresholds.maxBulkOpsPerMigration) {
      warnings.push({
        type: 'performance-bulk-ops-count',
        code: 'TOO_MANY_BULK_OPS',
        message: replaceAll(messages.tooManyBulkOps, '{count}', bulkOps),
        value: bulkOps,
        threshold: thresholds.maxBulkOpsPerMigration
      });
    }

    // 5. Count $lookup stages in aggregates
    const lookupCount = (js.match(/\$lookup\s*:/g) || []).length;
    metrics.lookupCount = lookupCount;

    if (lookupCount > thresholds.maxLookupStages) {
      warnings.push({
        type: 'performance-too-many-lookups',
        code: 'TOO_MANY_LOOKUPS',
        message: replaceAll(messages.tooManyLookups, '{count}', lookupCount),
        value: lookupCount,
        threshold: thresholds.maxLookupStages
      });
    }

    // 6. Check for find() without limit()
    // Match: .find(...) not followed by .limit(
    if (/\.find\s*\([^)]*\)(?!\s*\.\s*limit)/i.test(js)) {
      // Exclude cases where toArray() or forEach is used with reasonable patterns
      if (!/\.find\s*\([^)]*\)\s*\.\s*(?:limit|count|countDocuments)/i.test(js)) {
        warnings.push({
          type: 'performance-unbounded-find',
          code: 'UNBOUNDED_FIND',
          message: messages.unboundedFind
        });
      }
    }

    // 7. Check for sort() without limit() (potential memory issues)
    if (/\.sort\s*\([^)]*\)(?!\s*\.\s*limit)/i.test(js)) {
      warnings.push({
        type: 'performance-sort-without-limit',
        code: 'SORT_WITHOUT_LIMIT',
        message: messages.sortWithoutIndex
      });
    }

    // 8. Count aggregate pipeline complexity
    const aggregateMatches = js.match(/\.aggregate\s*\(\s*\[/g) || [];
    metrics.aggregateCount = aggregateMatches.length;

    // Count total pipeline stages (rough estimate by counting $stage patterns)
    const pipelineStages = (js.match(/\$(?:match|project|group|sort|limit|skip|unwind|lookup|addFields|set|replaceRoot|merge|out|facet)\s*:/g) || []).length;
    metrics.pipelineStagesCount = pipelineStages;

    if (pipelineStages > thresholds.maxPipelineStages) {
      warnings.push({
        type: 'performance-complex-aggregate',
        code: 'COMPLEX_AGGREGATE',
        message: replaceAll(messages.tooManyPipelineStages, '{count}', pipelineStages),
        value: pipelineStages,
        threshold: thresholds.maxPipelineStages
      });
    }

    return {
      warnings,
      metrics,
      summary: {
        totalWarnings: warnings.length,
        hasCriticalPerformanceIssues: warnings.some(w => 
          ['TOO_MANY_INDEXES', 'TOO_MANY_BULK_OPS', 'MIGRATION_TOO_LONG'].includes(w.code)
        )
      }
    };
  }
}

export default MongoDBAdapter;
