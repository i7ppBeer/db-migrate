/**
 * MongoDB Adapter
 * Uses migrate-mongo for connecting and scaffolding; status/up/down are
 * implemented here (migrate-mongo can't exclude R__ files from a DDL dir).
 */

import { BaseAdapter, isRepeatableMigrationFile, selectPendingMigrations } from '../core/base-adapter.js';
import { listMigrationFiles, pickDir, findExisting } from '../core/migration-dirs.js';
import { SanityChecker, MongoDBChecks } from '../core/sanity-checker.js';
import migrateMongo from 'migrate-mongo';
import { MongoClient, MongoOperationTimeoutError } from 'mongodb';
import { maskComments, findMatchingBrace } from '../core/source-scan.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// Collection operations whose run time grows with the collection (see findHeavyOperations())
const HEAVY_COLLECTION_OPS = ['createIndex', 'createIndexes', 'updateMany', 'deleteMany', 'bulkWrite'];

/** "600000" → 600000, "0" → 0, anything else → null. */
function parseOperationTimeoutAnnotation(raw) {
  return /^\d+$/.test(String(raw).trim()) ? Number(String(raw).trim()) : null;
}

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
          { pattern: /\.dropCollection\s*\(/i, code: 'DROP_COLLECTION', message: '🟠 DATA LOSS: dropCollection() will delete entire collection / 會刪除整個 Collection', suggestion: 'Confirm deletion and ensure backup exists / 確認真的要刪除，並確保有備份' },
          // deleteMany() with no filter deletes everything too (the driver treats it as {})
          { pattern: /\.deleteMany\s*\(\s*(?:\{\s*\}\s*)?(?:,|\))/i, code: 'DELETE_ALL', message: '🟠 DATA LOSS: deleteMany() with an empty/missing filter will delete all documents / 會刪除所有文件', suggestion: 'Add query condition / 請加上查詢條件' },
          { pattern: /\bdeleteMany\s*:\s*\{\s*filter\s*:\s*\{\s*\}/i, code: 'DELETE_ALL', message: '🟠 DATA LOSS: bulkWrite deleteMany with an empty filter will delete all documents / 會刪除所有文件', suggestion: 'Add query condition / 請加上查詢條件' },
          { pattern: /\.remove\s*\(\s*(?:\{\s*\}\s*)?(?:,|\))/i, code: 'REMOVE_ALL', message: '🟠 DATA LOSS: remove({}) will delete all documents / 會刪除所有文件', suggestion: 'Use deleteMany with query condition / 請使用 deleteMany 並加上條件' }
        ],
        bulkOperation: [
          { pattern: /\.updateMany\s*\(\s*\{\s*\}\s*,|\bupdateMany\s*:\s*\{\s*filter\s*:\s*\{\s*\}/i, code: 'UPDATE_ALL', message: '🟠 DATA RISK: updateMany({}, ...) will update all documents / 會更新所有文件', suggestion: 'Add query condition / 請加上查詢條件' },
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
      const existingOptions = this.config.mongodb?.options || {};
      const migrateMongoConfig = {
        ...this.config,
        mongodb: {
          ...this.config.mongodb,
          options: {
            // Gate R0: fail fast on an unreachable host instead of the
            // driver's own default server-selection timeout (30s). User-
            // supplied options (if any) win over these defaults.
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 10000,
            ...existingOptions
          }
        },
        changelogCollectionName: this.config.changelogCollection || this.config.changelogCollectionName || 'changelog'
      };
      migrateMongo.config.set(migrateMongoConfig);

      // Connect using migrate-mongo's method
      const { db, client } = await migrateMongo.database.connect();
      this.db = db;
      this.client = client;

      // Gate R0: identity check — confirm the connection actually points at
      // the database config says it should, before anything else touches it.
      // db.databaseName is reported by the driver itself, no query needed.
      const expectedDbName = this.config.mongodb?.databaseName;
      if (expectedDbName && db.databaseName !== expectedDbName) {
        await client.close();
        this.db = null;
        this.client = null;
        throw new Error(
          `Connected to the wrong database — expected '${expectedDbName}' but the connection reports '${db.databaseName}'. ` +
          `This usually means an environment variable resolved to the wrong host/database. Refusing to proceed.`
        );
      }

      // Gate R0: MongoDB creates a database on first write, so a typo'd name
      // or wrong environment would quietly get a brand-new empty database.
      // Versioned (DDL) runs refuse a database that doesn't exist yet unless
      // createDatabaseIfMissing is set (new environments, local/test setups).
      if (expectedDbName && this.config.mode !== 'repeatable' && !this.config.createDatabaseIfMissing) {
        let names = null;
        try {
          const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
          names = databases.map(d => d.name);
        } catch (listError) {
          // Accounts without listDatabases rights: can't tell, don't block.
          console.warn(`  ⚠️  Could not check that database '${expectedDbName}' exists (${listError.message}) — continuing.`);
        }
        if (names && !names.includes(expectedDbName)) {
          await client.close();
          this.db = null;
          this.client = null;
          throw new Error(
            `database '${expectedDbName}' does not exist on this server. Check the URL and database name. ` +
            'If this is a new environment and it should be created, set createDatabaseIfMissing: true in the config.'
          );
        }
      }

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
    await this.db.collection(this.changelogCollection).updateOne(
      { fileName },
      { $set: { checksum } }
    );
    return checksum;
  }

  async status() {
    try {
      // DCL/repeatable mode uses checksumCollection, not the DDL changelog collection.
      // Return empty DDL status — use `dcl:status` for DCL migration status.
      if (this.config.mode === 'repeatable') {
        return { pending: [], applied: [], total: 0 };
      }

      // Own bookkeeping instead of migrate-mongo's status(): migrate-mongo
      // treats every .js file in the directory as a migration, including
      // R__ (DCL) files, and has no way to filter them.
      const migrationFiles = await this.getMigrationFiles();
      const changelogDocs = await this.db.collection(this.changelogCollection).find({}).toArray();
      const docByFile = new Map(changelogDocs.map(d => [d.fileName, d]));

      const pending = [];
      const applied = [];
      const checksumMismatches = [];
      const checksumBaselined = [];
      // Applied migrations should form a contiguous prefix of the sorted
      // file list — once a pending file is seen, any LATER applied file (in
      // sort order) means migrations ran out of order or a file was renamed
      // after being applied.
      const outOfOrderApplied = [];
      let seenPending = false;

      for (const file of migrationFiles) {
        const doc = docByFile.get(file);
        if (!doc) {
          pending.push(file);
          seenPending = true;
          continue;
        }
        if (seenPending) outOfOrderApplied.push(file);
        applied.push({ fileName: file, appliedAt: doc.appliedAt });

        let currentChecksum = null;
        try {
          const content = await fs.readFile(path.join(this.config.migrationsDir, file), 'utf-8');
          currentChecksum = this.calculateChecksum(content);
        } catch {
          // File unreadable (permissions, race) — skip the checksum check
          // for this entry rather than fail status() entirely.
        }
        if (currentChecksum) {
          if (doc.checksum == null && this.readOnly) {
            // Would be baselined by a writing command; read-only leaves it.
          } else if (doc.checksum == null) {
            // Doc predates checksum tracking (upgraded from an older version
            // of this tool, or written by migrate-mongo itself). Adopt current
            // content as the trusted baseline going forward.
            await this.db.collection(this.changelogCollection).updateOne(
              { fileName: file },
              { $set: { checksum: currentChecksum } }
            );
            checksumBaselined.push(file);
          } else if (doc.checksum !== currentChecksum) {
            checksumMismatches.push({ fileName: file, appliedAt: doc.appliedAt });
          }
        }
      }

      // Gate R1 (remaining checks): a changelog doc with no file on disk.
      // R__ entries are reported separately — older versions of this tool
      // ran R__ files found in a DDL directory as versioned migrations, and
      // those leftover docs are not a sign of a deleted/renamed migration.
      const fileNameSet = new Set(migrationFiles);
      const orphanedChangelogEntries = [];
      const ignoredRepeatableEntries = [];
      for (const d of changelogDocs) {
        if (fileNameSet.has(d.fileName)) continue;
        if (isRepeatableMigrationFile(d.fileName)) ignoredRepeatableEntries.push(d.fileName);
        else orphanedChangelogEntries.push({ id: d.fileName, appliedAt: d.appliedAt });
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
   * Versioned migration files, in run order. R__ (repeatable/DCL) files are
   * excluded — see isRepeatableMigrationFile().
   */
  async getMigrationFiles() {
    const files = await fs.readdir(this.config.migrationsDir);
    return files.filter(f => f.endsWith('.js') && !isRepeatableMigrationFile(f)).sort();
  }

  /** R__ files sitting in this versioned directory, which status/up/validate ignore. */
  async getIgnoredRepeatableFiles() {
    if (this.config.mode === 'repeatable') return [];
    const files = await fs.readdir(this.config.migrationsDir);
    return files.filter(f => f.endsWith('.js') && isRepeatableMigrationFile(f)).sort();
  }

  /** @private */
  async _loadMigration(fileName) {
    const filePath = path.join(this.config.migrationsDir, fileName);
    const content = await fs.readFile(filePath, 'utf-8');
    const module = await import(`file://${filePath}?t=${Date.now()}`);
    return { module, content };
  }

  /**
   * Gate R5 for MongoDB: ddlSafety.operationTimeoutMs, or null when unset
   * (off by default — a limit that's too low would fail legitimate index
   * builds, so each project picks its own).
   */
  getOperationTimeoutMs() {
    const value = this.config.ddlSafety?.operationTimeoutMs;
    if (value == null || value === 0) return null;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`ddlSafety.operationTimeoutMs must be a positive integer (milliseconds), got: ${value}`);
    }
    return value;
  }

  /**
   * The db/client a migration's up()/down() receive. With an operation time
   * limit set, both carry the driver's timeoutMS, so every operation issued
   * through them — including through client.db('other') — is bounded and
   * stopped on the server when it runs over, instead of a write stuck behind
   * another lock hanging the whole run.
   * @private
   */
  _migrationHandles(content = '') {
    const { timeoutMS, source } = this.resolveOperationTimeout(content);
    if (!timeoutMS) return { db: this.db, client: this.client, timeoutMS: null, source };
    const db = this.client.db(this.db.databaseName, { timeoutMS });
    const client = new Proxy(this.client, {
      get(target, prop) {
        if (prop === 'db') return (name, opts = {}) => target.db(name, { timeoutMS, ...opts });
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return { db, client, timeoutMS, source };
  }

  /**
   * The limit for one migration file: its own `// @operation-timeout-ms: N`
   * annotation (0 = no limit for this file) wins over ddlSafety.operationTimeoutMs
   * — so one known-slow migration (a large index build) can get more time
   * without loosening every other one.
   * @returns {{ timeoutMS: number|null, source: string }}
   */
  resolveOperationTimeout(content = '') {
    const raw = this.parseFileAnnotations(content).operationTimeoutMs;
    if (raw != null) {
      const value = parseOperationTimeoutAnnotation(raw);
      if (value === null) throw new Error(`@operation-timeout-ms must be a whole number of milliseconds (0 = no limit for this file), got: ${raw}`);
      return { timeoutMS: value || null, source: '@operation-timeout-ms' };
    }
    return { timeoutMS: this.getOperationTimeoutMs(), source: 'ddlSafety.operationTimeoutMs' };
  }

  /**
   * Call a migration's up/down with the R5-bounded handles; a timeout is
   * reported against the setting that caused it (callers prefix the file name).
   * @private
   */
  async _runMigrationFunction(fn, content = '') {
    const { db, client, timeoutMS, source } = this._migrationHandles(content);
    try {
      await fn(db, client);
    } catch (error) {
      const timedOut = error instanceof MongoOperationTimeoutError || error?.code === 50 || error?.codeName === 'MaxTimeMSExpired';
      if (timeoutMS && timedOut) {
        const hint = source === '@operation-timeout-ms'
          ? 'If this migration needs longer, raise the value in its "// @operation-timeout-ms:" line (0 = no limit), or run it off-peak.'
          : 'If this migration is expected to be slow (e.g. a large index build), give just this file more time with "// @operation-timeout-ms: <ms>" at the top (0 = no limit), or run it off-peak.';
        throw new Error(`An operation ran longer than ${source} (${timeoutMS} ms) and was stopped (${error.message}). ${hint}`);
      }
      throw error;
    }
  }

  /**
   * Run one migration's up() and record it in the changelog.
   * @private
   */
  async _applyOne(fileName) {
    const { module, content } = await this._loadMigration(fileName);
    if (typeof module.up !== 'function') throw new Error('Migration must export an "up" function');
    await this._runMigrationFunction(module.up, content);
    await this.db.collection(this.changelogCollection).insertOne({
      fileName,
      appliedAt: new Date(),
      checksum: this.calculateChecksum(content)
    });
  }

  /**
   * Run one migration's down() and remove it from the changelog.
   * @private
   */
  async _rollbackOne(fileName) {
    const { module, content } = await this._loadMigration(fileName);
    if (typeof module.down !== 'function') throw new Error('Migration must export a "down" function');
    await this._runMigrationFunction(module.down, content);
    await this.db.collection(this.changelogCollection).deleteOne({ fileName });
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

          // Baseline establishes the trust baseline itself — store the
          // current file's checksum so future edits to it are still detected,
          // even though up() was never actually executed here.
          const content = await fs.readFile(path.join(this.config.migrationsDir, fileName), 'utf-8');
          await this.db.collection(this.changelogCollection).insertOne({
            fileName,
            appliedAt: new Date(),
            checksum: this.calculateChecksum(content)
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

  /**
   * Delete all documents from a changelog/checksum collection. Does NOT run down()
   * and does NOT touch any actual collections/documents — this only clears the
   * tool's own tracking records, so the next `status`/`up`/`dcl` treats every
   * migration as pending again.
   *
   * Used for both DDL (changelog collection, `collectionName` omitted → uses
   * `this.changelogCollection`) and DCL (checksum collection, caller passes the
   * already-validated `collectionName`).
   *
   * @param {Object} [options]
   * @param {boolean} [options.dryRun=false] - Count only, don't delete
   * @param {string}  [options.collectionName] - Override collection (used for DCL checksum collections)
   * @returns {Promise<number>} Number of documents that existed before deletion
   */
  async resetChangelog({ dryRun = false, collectionName } = {}) {
    const coll = collectionName || this.changelogCollection;
    const count = await this.db.collection(coll).countDocuments({});
    if (!dryRun && count > 0) {
      await this.db.collection(coll).deleteMany({});
    }
    return count;
  }

  /**
   * Best-effort infer a human-readable type label for one field's sample value.
   * MongoDB is schemaless, so this is inference from one document, not a guarantee
   * every document in the collection shares this shape.
   * @private
   */
  _describeFieldType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (value && typeof value === 'object' && value._bsontype) return value._bsontype.toLowerCase();
    if (value && typeof value === 'object') return 'object';
    return typeof value;
  }

  /** All rule codes this adapter reports (for checking validation.rules). */
  knownValidationCodes() {
    const codes = new Set(['JS_SYNTAX_ERROR', 'MISSING_UP_EXPORT', 'MISSING_DOWN_EXPORT', 'MISSING_DOWN', 'ORPHAN_DROP_DOWN', 'ORPHAN_DROP_UP']);
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
   * Pre-execution runtime gates R2–R4 (docs/RUNTIME-GATE-PLAN.md). Read-only;
   * each check that can't run (missing privilege, standalone server) is
   * reported as skipped rather than failing the run.
   *
   *   R2 openTransactions — operations on this database running longer than
   *      longTransactionSec, and multi-document transactions open that long
   *      (currentOp; needs the inprog privilege, e.g. clusterMonitor)
   *   R3 readOnly — this connection is not to a writable primary
   *      (hello.isWritablePrimary); replication lag above
   *      replicationLagWarnSec is a warning only
   *   R4 warnings — filesystem usage above diskUsageWarnPercent (dbStats)
   *
   * @param {{ locks?: boolean, disk?: boolean }} [which] - R2 / R4 (R3 always)
   */
  async runtimePreflight({ locks = true, disk = true } = {}) {
    const cfg = this.getRuntimeGateConfig();
    const dbName = this.db.databaseName;
    const admin = this.client.db('admin');
    const out = { openTransactions: [], metadataLockWaits: [], readOnly: null, warnings: [], skipped: [] };

    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary === false) {
      out.readOnly = { reason: hello.secondary ? 'connected to a secondary' : 'not a writable primary' };
    }
    if (hello.setName) {
      try {
        const rs = await admin.command({ replSetGetStatus: 1 });
        const primary = rs.members.find(m => m.stateStr === 'PRIMARY');
        for (const m of rs.members.filter(m => m.stateStr === 'SECONDARY')) {
          const lagSec = primary ? (new Date(primary.optimeDate) - new Date(m.optimeDate)) / 1000 : null;
          if (lagSec !== null && lagSec > cfg.replicationLagWarnSec) {
            out.warnings.push(`Secondary ${m.name} is ${Math.round(lagSec)}s behind the primary — reads from it won't see this migration for a while`);
          }
        }
      } catch (error) {
        out.skipped.push(`R3 replication lag (needs replSetGetStatus): ${error.message}`);
      }
    }

    if (locks) {
      try {
        const escaped = dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { inprog } = await admin.command({
          currentOp: true,
          $or: [
            { active: true, secs_running: { $gt: cfg.longTransactionSec }, ns: { $regex: `^${escaped}\\.` } },
            { 'transaction.timeOpenMicros': { $gt: cfg.longTransactionSec * 1e6 } }
          ]
        });
        out.openTransactions = inprog.map(op => ({
          id: `opid ${op.opid}`,
          durationSec: op.secs_running ?? Math.round((op.transaction?.timeOpenMicros || 0) / 1e6),
          who: op.client || op.effectiveUsers?.map(u => u.user).join(',') || '?',
          query: `${op.op || 'transaction'} ${op.ns || ''} ${JSON.stringify(op.command || {}).slice(0, 160)}`.trim()
        }));
      } catch (error) {
        out.skipped.push(`R2 long-operation check (needs the inprog privilege, e.g. clusterMonitor): ${error.message}`);
      }
    }

    if (disk) {
      try {
        const stats = await this.db.command({ dbStats: 1 });
        if (stats.fsTotalSize > 0) {
          const usedPct = (stats.fsUsedSize / stats.fsTotalSize) * 100;
          if (usedPct > cfg.diskUsageWarnPercent) {
            out.warnings.push(`The database's filesystem is ${usedPct.toFixed(1)}% full (over ${cfg.diskUsageWarnPercent}%) — index builds and large updates need headroom`);
          }
        } else {
          out.skipped.push('R4 disk usage: not reported by this server');
        }
      } catch (error) {
        out.skipped.push(`R4 disk usage (dbStats): ${error.message}`);
      }
    }
    return out;
  }

  /**
   * Collections a migration's up() runs a potentially long operation on —
   * index builds and bulk updates/deletes, whose run time grows with the
   * collection. Finds db.collection('x').op(…) and, for
   * `const c = db.collection('x')`, c.op(…). Names built at runtime are not
   * seen.
   * @returns {Array<{collection: string, ops: string[]}>}
   */
  findHeavyOperations(content) {
    const body = maskComments(this.extractFunctionBody(content, 'up') || '', 'js');
    const opAlt = HEAVY_COLLECTION_OPS.join('|');
    const found = new Map();
    const add = (collection, op) => {
      if (!found.has(collection)) found.set(collection, new Set());
      found.get(collection).add(op);
    };
    for (const m of body.matchAll(new RegExp(`\\.collection\\s*\\(\\s*(['"\`])([^'"\`]+)\\1\\s*\\)\\s*\\.\\s*(${opAlt})\\s*\\(`, 'g'))) {
      add(m[2], m[3]);
    }
    const vars = new Map();
    for (const m of body.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*\.collection\s*\(\s*(['"`])([^'"`]+)\2\s*\)/g)) {
      vars.set(m[1], m[3]);
    }
    for (const m of body.matchAll(new RegExp(`\\b(\\w+)\\s*\\.\\s*(${opAlt})\\s*\\(`, 'g'))) {
      if (vars.has(m[1])) add(vars.get(m[1]), m[2]);
    }
    return [...found].map(([collection, ops]) => ({ collection, ops: [...ops] }));
  }

  /**
   * Gate R4 (advisory) for the migrations about to run: an index build or
   * bulk update/delete on a collection of runtimeGates.largeCollectionDocs
   * documents or more can run for a long time and load the server — said
   * before it starts, with the time limit that will (or won't) apply.
   * Read-only: estimatedDocumentCount() reads collection metadata.
   *
   * @param {string[]} files - pending migrations, in run order
   * @returns {Promise<{warnings: string[], skipped: string[]}>}
   */
  async largeCollectionWarnings(files) {
    const out = { warnings: [], skipped: [] };
    const threshold = this.getRuntimeGateConfig().largeCollectionDocs;
    if (!threshold || !files || files.length === 0) return out;
    const counts = new Map();
    for (const fileName of files) {
      try {
        const content = await fs.readFile(path.join(this.config.migrationsDir, fileName), 'utf-8');
        for (const { collection, ops } of this.findHeavyOperations(content)) {
          if (!counts.has(collection)) counts.set(collection, await this.db.collection(collection).estimatedDocumentCount());
          const docs = counts.get(collection);
          if (docs < threshold) continue;
          const { timeoutMS, source } = this.resolveOperationTimeout(content);
          const limit = timeoutMS
            ? `each operation is stopped after ${timeoutMS} ms (${source}) — check that's enough at this size, or the migration fails partway`
            : 'no operation time limit applies — set ddlSafety.operationTimeoutMs, or "// @operation-timeout-ms: <ms>" in this file, to bound it';
          out.warnings.push(`${fileName}: ${ops.join(', ')} on '${collection}' (${docs.toLocaleString('en-US')} documents, over runtimeGates.largeCollectionDocs = ${threshold.toLocaleString('en-US')}) ` +
            `may run for a long time and load the server; ${limit}. Consider running it off-peak.`);
        }
      } catch (error) {
        out.skipped.push(`R4 large-collection check for ${fileName}: ${error.message}`);
      }
    }
    return out;
  }

  /**
   * Snapshot the real, current schema — one entry per collection with its indexes
   * and a best-effort field shape inferred from a single sample document.
   * Used by the `sync` CLI command to show what the database actually looks like
   * after applying migrations, rather than trusting the migration files alone.
   *
   * @returns {Promise<{collection: string, count: number, indexes: string[], fields: {name: string, type: string}[]}[]>}
   */
  async getSchemaSnapshot() {
    const collections = await this.db.listCollections().toArray();
    const snapshot = [];

    for (const c of collections) {
      const coll = this.db.collection(c.name);
      const [count, indexes, sample] = await Promise.all([
        coll.estimatedDocumentCount(),
        coll.indexes(),
        coll.findOne({})
      ]);

      const fields = sample
        ? Object.keys(sample).map(name => ({ name, type: this._describeFieldType(sample[name]) }))
        : [];

      snapshot.push({
        collection: c.name,
        count,
        indexes: indexes.map(i => i.name),
        fields
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
      const { pending } = await this.status();
      const { selected, error } = selectPendingMigrations(pending, options);
      if (error) {
        result.errors.push(error);
        return result;
      }

      for (const fileName of selected) {
        try {
          await this._applyOne(fileName);
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
    
    // Otherwise, it's options for batch migration — one migration at a
    // time, so every file's own preCheck/postCheck actually runs (and
    // --target/--only are honored, same as up()).
    const batchOptions = migrationOrOptions;
    const result = {
      applied: [],
      errors: [],
      sanityResults: []
    };

    const { pending } = await this.status();
    const { selected, error } = selectPendingMigrations(pending, batchOptions);
    if (error) {
      result.errors.push(error);
      return result;
    }

    for (const fileName of selected) {
      try {
        const { module: migrationModule } = await this._loadMigration(fileName);

        if (migrationModule.preCheck || migrationModule.postCheck) {
          console.log(`\n🔍 Running ${fileName} with sanity checks...`);
          const checker = new SanityChecker({
            enabled: true,
            autoRollback: this.config.sanityCheck?.autoRollback ?? true,
            timeoutMs: this.config.sanityCheck?.timeoutMs ?? 30000,
            verbose: options.verbose ?? this.config.sanityCheck?.verbose ?? true
          });
          const sanityResult = await checker.runWithSanityCheck({
            up: () => this._applyOne(fileName),
            down: () => this._rollbackOne(fileName),
            preCheck: migrationModule.preCheck,
            postCheck: migrationModule.postCheck,
            context: { db: this.db, client: this.client, config: this.config }
          });
          result.sanityResults.push({ file: fileName, ...sanityResult });

          if (!sanityResult.success) {
            result.errors.push(`${fileName}: ${sanityResult.error}`);
            break;
          }
          result.applied.push(fileName);
        } else {
          await this._applyOne(fileName);
          result.applied.push(fileName);
          result.sanityResults.push({ file: fileName, success: true, skipped: true });
        }
      } catch (error) {
        result.errors.push(`${fileName}: ${error.message}`);
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

  /**
   * What `down` would roll back, most recent first (by appliedAt, file order
   * as tie-break): the last `count`, or — with `target` — everything applied
   * after it and the target itself. Also returns which of those files were
   * edited since being applied.
   * @returns {Promise<{files: string[], error: string|null, checksumMismatches: string[]}>}
   */
  async rollbackPlan({ count = 1, target } = {}) {
    const status = await this.status();
    const order = new Map((await this.getMigrationFiles()).map((f, i) => [f, i]));
    const newestFirst = [...status.applied]
      .sort((a, b) => (new Date(b.appliedAt) - new Date(a.appliedAt)) || (order.get(b.fileName) - order.get(a.fileName)))
      .map(a => a.fileName);
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
        try {
          await this._rollbackOne(fileName);
          result.rolledBack.push(fileName);
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

  async create(name) {
    try {
      // migrate-mongo.create() needs config set (normally done in connect(), but create doesn't need a DB connection)
      migrateMongo.config.set({
        ...this.config,
        changelogCollectionName: this.config.changelogCollection || this.config.changelogCollectionName || 'changelog',
        moduleSystem: 'esm'
      });

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
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] - which of a multi-directory migrationsDir to create it in (see pickDir())
   */
  async createDCL(name, sequenceNumber = '', { dir } = {}) {
    // Generate filename: R__001_name.js or R__name.js
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const prefix = sequenceNumber ? `R__${sequenceNumber}_` : 'R__';
    const fileName = `${prefix}${sanitizedName}.js`;
    const filePath = path.join(pickDir(this.config.migrationsDir, dir), fileName);

    // Already there — in this directory or, with several, in any of them
    // (the same name in two directories is rejected when DCL runs)
    const existingIn = await findExisting(this.config.migrationsDir, fileName);
    if (existingIn) throw new Error(`DCL migration file already exists: ${path.join(existingIn, fileName)}`);

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
      // Same file set and order status()/up() use: in a versioned project,
      // R__ (DCL) files are ignored and reported, not validated as DDL.
      // DCL may list several directories (see core/migration-dirs.js).
      const repeatableFiles = this.config.mode === 'repeatable'
        ? await listMigrationFiles(migrationsDir, f => f.endsWith('.js'))
        : null;
      const migrationFiles = repeatableFiles
        ? repeatableFiles.map(f => f.fileName)
        : await this.getMigrationFiles();
      const filePathOf = new Map((repeatableFiles || []).map(f => [f.fileName, f.filePath]));
      results.ignoredRepeatableFiles = await this.getIgnoredRepeatableFiles();
      // options.files: validate only these (e.g. the pending ones); the rest
      // are listed as skipped so the caller can say so.
      const wanted = options.files ? new Set(options.files) : null;
      if (wanted) results.skippedFiles = migrationFiles.filter(f => !wanted.has(f));

      const filesData = [];
      for (const file of migrationFiles) {
        filesData.push({ fileName: file, content: await fs.readFile(filePathOf.get(file) || path.join(migrationsDir, file), 'utf-8') });
      }
      results.configWarnings = this.checkValidationConfig(migrationFiles);
      const knownBefore = this.config.mode === 'repeatable' ? null : this.collectionsBeforeEachFile(filesData);

      for (const [i, { fileName: file, content }] of filesData.entries()) {
        if (wanted && !wanted.has(file)) continue;
        const fileResult = this.validateContent(content, file, {
          ...options,
          ...(knownBefore ? { knownCollections: knownBefore[i] } : {})
        });
        
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
      allowedCodes: [],
      approvedBy: null,
      operationTimeoutMs: null
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
      const timeoutMatch = t.match(/\/\/\s*@operation-timeout-ms\s*:\s*(.+)/i);
      if (timeoutMatch) annotations.operationTimeoutMs = timeoutMatch[1].trim();
      const approvedMatch = t.match(/\/\/\s*@approved-by\s*:\s*(.+)/i);
      if (approvedMatch && approvedMatch[1].trim()) annotations.approvedBy = approvedMatch[1].trim();
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
      allowedCodes: [
        ...(options.allowedCodes || []),
        ...(fileAnnotations.allowedCodes || []),
        ...(this.getValidationConfig().allow[fileName] || [])
      ]
    };
    options = effectiveOptions;

    const syntaxResult = this.validateJSSyntax(content, fileName);
    const errors = [...syntaxResult.errors];
    if (fileAnnotations.operationTimeoutMs != null && parseOperationTimeoutAnnotation(fileAnnotations.operationTimeoutMs) === null) {
      errors.push({
        type: 'invalid-annotation',
        code: 'INVALID_OPERATION_TIMEOUT',
        message: `🔴 @operation-timeout-ms must be a whole number of milliseconds (0 = no limit for this file), got: ${fileAnnotations.operationTimeoutMs}`
      });
    }
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
          code: 'MISSING_DOWN',
          operation: 'down()',
          message: 'down() is empty but up() contains operations - rollback missing!'
        });
      }
    }

    // === 2. Extract created collections in up() ===
    const createdCollections = this.extractCreatedCollections(upBody);
    const createdCollectionsInDown = this.extractCreatedCollections(downBody);
    const droppedCollectionsInDown = this.extractDroppedCollections(downBody);
    const droppedCollectionsInUp = this.extractDroppedCollections(upBody);
    
    // === 3. DDL only: Check for orphan drops in down() (R__ repeatable files have no up/down) ===
    // Same false-positive concern as MariaDB's equivalent check: a collection
    // this migration didn't create being dropped is a completely normal
    // pattern (created by an earlier migration, removed by a later one) that
    // this single-file check can't distinguish from a real mistake. Allow it
    // the same way a dangerous op is allowed: --allow-dangerous, or the
    // specific code via --allow/@allow.
    if (this.config.mode !== 'repeatable') {
      const isOrphanDropAllowed = (code) =>
        options.allowDangerous || (options.allowedCodes && options.allowedCodes.includes(code));

      for (const dropped of droppedCollectionsInDown) {
        if (!createdCollections.includes(dropped)) {
          if (isOrphanDropAllowed('ORPHAN_DROP_DOWN')) {
            warnings.push({
              type: 'orphan-drop-allowed',
              code: 'ORPHAN_DROP_DOWN',
              message: `⚠️ [ALLOWED] Orphan drop: down() drops '${dropped}' but up() doesn't create it — assumed created by an earlier migration`
            });
          } else {
            errors.push({
              type: 'orphan-drop',
              code: 'ORPHAN_DROP_DOWN',
              operation: 'drop',
              message: `Orphan drop: down() drops '${dropped}' but up() doesn't create it`
            });
          }
        }
      }

      // === 3b. Check for orphan drops in up() ===
      for (const dropped of droppedCollectionsInUp) {
        if (!createdCollections.includes(dropped)) {
          // Smart allowance: if down() recreates exactly what up() dropped, this
          // is a genuine, self-contained reverse migration for a collection an
          // earlier file created — no flag needed.
          if (createdCollectionsInDown.includes(dropped)) {
            warnings.push({
              type: 'orphan-drop-in-up-allowed',
              code: 'ORPHAN_DROP_UP',
              message: `✅ [ALLOWED] Orphan drop in up(): '${dropped}' is dropped but not created in this migration — allowed because down() recreates it`
            });
          } else if (options.knownCollections && options.knownCollections.has(dropped)) {
            // validate() knows every earlier file: the collection really
            // exists, so this isn't a typo. Dropping it still needs approval —
            // that's the DROP_COLLECTION dangerous rule, reported below.
          } else if (isOrphanDropAllowed('ORPHAN_DROP_UP')) {
            warnings.push({
              type: 'orphan-drop-in-up-allowed',
              code: 'ORPHAN_DROP_UP',
              message: `⚠️ [ALLOWED] Orphan drop in up(): '${dropped}' is dropped but not created in this migration — assumed created by an earlier migration`
            });
          } else {
            errors.push({
              type: 'orphan-drop-in-up',
              code: 'ORPHAN_DROP_UP',
              operation: 'drop',
              message: options.knownCollections
                ? `Orphan drop in up(): '${dropped}' was not created by any earlier migration and is not listed in validation.existingCollections — check the name (or declare the collection there if it predates these migrations)`
                : `Orphan drop in up(): '${dropped}' is dropped but not created in this migration`
            });
          }
        }
      }
    }

    // === 4. Check for forbidden operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const rule of rules.forbidden[category]) {
        // No automatic allowance for dropDatabase in down(): MongoDB has no
        // "this migration created the database" — up() creating one
        // collection doesn't mean rolling it back may delete every other
        // collection in the database. (MariaDB's equivalent only applies to
        // a CREATE DATABASE in the same file.) Explicit approval still works.
        if (rule.code === 'DROP_DATABASE' || rule.code === 'DROP_DATABASE_CMD') {
          const hasDropDBInUp = /dropDatabase/i.test(normalizedUpBody);

          // Forbid dropDatabase in up() unless explicitly approved via @allow-forbidden
          if (hasDropDBInUp) {
            // Only the rule whose own pattern matches: .dropDatabase() is
            // DROP_DATABASE, { dropDatabase: 1 } is DROP_DATABASE_CMD — not
            // both, or allowing the one code shown could never be enough.
            if (!rule.pattern.test(normalizedUpBody)) continue;
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

    // Project policy (validation.customRules / validation.rules — see BaseAdapter.getValidationPolicy())
    this.evaluateCustomRules([normalizedUpBody || normalizedContent], options, { forbiddenOps, dangerousOps, warnings });
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
      suspiciousNames: suspiciousNames,
      performanceIssues: performanceResult.warnings,
      performanceMetrics: performanceResult.metrics,
      summary: {
        forbidden: policy.forbiddenOps.length,
        dangerous: policy.dangerousOps.length,
        warnings: policy.warnings.length,
        structural: policy.errors.length,
        suspiciousNames: suspiciousNames.length,
        performanceIssues: performanceResult.warnings.length
      }
    };
  }

  /**
   * For each file (in run order), the collections that exist before it runs:
   * validation.existingCollections plus everything earlier files created and
   * didn't drop.
   * @returns {Array<Map<string, string>>} collection → where it came from
   */
  collectionsBeforeEachFile(filesData) {
    const known = new Map(this.getValidationConfig().existing.map(c => [c, 'listed in validation.existingCollections']));
    const out = [];
    for (const { fileName, content } of filesData) {
      out.push(new Map(known));
      const upBody = this.extractFunctionBody(content, 'up');
      for (const c of this.extractDroppedCollections(upBody)) known.delete(c);
      for (const c of this.extractCreatedCollections(upBody)) known.set(c, `created by ${fileName}`);
    }
    return out;
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
    // db.dropCollection('name')
    const dropCollectionRegex = /\.dropCollection\s*\(\s*['"]([^'"]+)['"]/g;
    while ((match = dropCollectionRegex.exec(code)) !== null) {
      collections.push(match[1]);
    }
    return collections;
  }

  /**
   * Body of up()/down() (between its braces), whatever the declaration style:
   * `export async function up(…) {`, `export const up = async (…) => {`, or a
   * method `async up(…) {`. Braces are matched (nested object literals,
   * strings and comments included), not regex-guessed.
   */
  extractFunctionBody(content, functionName) {
    const code = maskComments(content, 'js');
    const headers = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`),
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>\\s*\\{`),
      new RegExp(`(?:^|[\\s,{])async\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`)
    ];
    for (const header of headers) {
      const m = header.exec(code);
      if (!m) continue;
      const open = m.index + m[0].length - 1;
      const close = findMatchingBrace(content, open);
      return close === -1 ? content.slice(open + 1) : content.slice(open + 1, close);
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
      // eslint-disable-next-line no-misleading-character-class -- distinct zero-width codepoints to strip, not a joined sequence
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, '')
      // Convert fullwidth characters to halfwidth (Unicode normalization)
      .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      // Remove comments FIRST (quote-aware) so an apostrophe in a comment
      // ("// if there's bad data") can't start a fake string literal that
      // swallows the real code after it
      .replace(/[\s\S]*/, src => maskComments(src, 'js'))
      // Remove template literals (backticks) - replace with placeholder
      .replace(/`(?:[^`\\]|\\.)*`/g, "'__STRING__'")
      // Remove string literals (single quotes) to avoid false positives
      .replace(/'(?:[^'\\]|\\.)*'/g, "'__STRING__'")
      // Remove string literals (double quotes)
      .replace(/"(?:[^"\\]|\\.)*"/g, '"__STRING__"')
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
