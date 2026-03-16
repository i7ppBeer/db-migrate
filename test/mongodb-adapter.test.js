/**
 * MongoDB Adapter Tests with Sanity Check
 * 測試 MongoDB 遷移適配器的 Sanity Check 功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

// Mock migrate-mongo
vi.mock('migrate-mongo', () => ({
  default: {
    config: { set: vi.fn() },
    database: {
      connect: vi.fn().mockResolvedValue({
        client: { close: vi.fn() },
        db: {}
      })
    },
    status: vi.fn().mockResolvedValue([]),
    up: vi.fn().mockResolvedValue([]),
    down: vi.fn().mockResolvedValue([])
  }
}));

describe('MongoDBAdapter', () => {
  let adapter;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      migrationsDir: '/test/migrations',
      migrationFileExtension: '.js',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'test',
        options: {}
      },
      sanityCheck: {
        enabled: true,
        autoRollback: true,
        timeout: 30000
      }
    };
    adapter = new MongoDBAdapter(mockConfig);
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(adapter.config).toBe(mockConfig);
      expect(adapter.sanityChecker).toBeDefined();
    });

    it('should initialize sanity checker with config options', () => {
      expect(adapter.sanityChecker.options.timeout).toBe(30000);
      expect(adapter.sanityChecker.options.autoRollback).toBe(true);
    });

    it('should work without sanityCheck config', () => {
      const configWithoutSanity = { ...mockConfig };
      delete configWithoutSanity.sanityCheck;
      
      const adapterNoSanity = new MongoDBAdapter(configWithoutSanity);
      expect(adapterNoSanity.sanityChecker).toBeDefined();
    });
  });

  describe('getSanityCheckHelpers', () => {
    it('should return MongoDB check helpers', () => {
      const helpers = adapter.getSanityCheckHelpers();
      
      expect(helpers).toHaveProperty('collectionExists');
      expect(helpers).toHaveProperty('indexExists');
      expect(helpers).toHaveProperty('documentCount');
      expect(helpers).toHaveProperty('hasField');
      expect(typeof helpers.collectionExists).toBe('function');
    });
  });

  describe('upWithSanityCheck', () => {
    it('should execute migration with sanity checks', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ 
          success: true, 
          details: ['Pre-check passed'] 
        }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ 
          success: true, 
          details: ['Post-check passed'] 
        }),
        down: vi.fn()
      };

      // Mock the internal methods
      adapter.connect = vi.fn().mockResolvedValue({ 
        db: {}, 
        client: { close: vi.fn() } 
      });

      const result = await adapter.upWithSanityCheck(migration);

      expect(result.success).toBe(true);
      expect(result.preCheckResult.success).toBe(true);
      expect(result.postCheckResult.success).toBe(true);
      expect(migration.up).toHaveBeenCalled();
    });

    it('should skip migration when preCheck fails', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Collection already exists' 
        }),
        up: vi.fn(),
        postCheck: vi.fn(),
        down: vi.fn()
      };

      adapter.connect = vi.fn().mockResolvedValue({ 
        db: {}, 
        client: { close: vi.fn() } 
      });

      const result = await adapter.upWithSanityCheck(migration);

      expect(result.success).toBe(false);
      expect(migration.up).not.toHaveBeenCalled();
    });

    it('should auto-rollback on postCheck failure', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Index creation failed' 
        }),
        down: vi.fn().mockResolvedValue(undefined)
      };

      adapter.connect = vi.fn().mockResolvedValue({ 
        db: {}, 
        client: { close: vi.fn() } 
      });

      const result = await adapter.upWithSanityCheck(migration);

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(migration.down).toHaveBeenCalled();
    });

    it('should respect autoRollback option', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Sanity check failed' 
        }),
        down: vi.fn()
      };

      adapter.connect = vi.fn().mockResolvedValue({ 
        db: {}, 
        client: { close: vi.fn() } 
      });

      const result = await adapter.upWithSanityCheck(migration, { autoRollback: false });

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(migration.down).not.toHaveBeenCalled();
    });
  });

  // =========================================
  // String Literal False Positive Prevention Tests
  // 字串常量誤判防護測試
  // =========================================
  describe('normalizeJS - String Literal Protection', () => {
    it('should replace single-quoted strings with placeholder', () => {
      const js = "const msg = 'dropDatabase is dangerous';";
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe("const msg = '__STRING__';");
      expect(normalized).not.toContain('dropDatabase');
    });

    it('should replace double-quoted strings with placeholder', () => {
      const js = 'const msg = "dropDatabase is dangerous";';
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe('const msg = "__STRING__";');
      expect(normalized).not.toContain('dropDatabase');
    });

    it('should replace template literals with placeholder', () => {
      const js = 'const msg = `dropDatabase is ${action}`;';
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe("const msg = '__STRING__';");
      expect(normalized).not.toContain('dropDatabase');
    });

    it('should not trigger dangerous detection on string values', () => {
      // Log message contains dangerous keyword, but it's just a string value
      const js = `
        export const up = async (db) => {
          console.log('Warning: dropDatabase is forbidden');
          await db.collection('audit_log').insertOne({
            action: "User tried to dropDatabase",
            timestamp: new Date()
          });
        };
      `;
      
      const result = adapter.validateContent(js, 'test.js');
      // Should not have forbidden errors related to DROP_DATABASE
      const dropErrors = result.forbiddenOps.filter(e => e.code === 'DROP_DATABASE');
      expect(dropErrors.length).toBe(0);
    });

    it('should still detect actual dangerous operations', () => {
      const js = `
        export const up = async (db) => {
          await db.dropDatabase();
        };
      `;
      
      const result = adapter.validateContent(js, 'test.js');
      const dropErrors = result.forbiddenOps.filter(e => e.code === 'DROP_DATABASE');
      expect(dropErrors.length).toBe(1);
    });

    it('should handle escaped quotes in strings', () => {
      const js = "const msg = 'It\\'s dropDatabase';";
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe("const msg = '__STRING__';");
      expect(normalized).not.toContain('dropDatabase');
    });

    it('should preserve code structure while removing string content', () => {
      const js = `
        const a = 'dropDatabase';
        const b = actualDropDatabase();
        const c = "another dropDatabase message";
      `;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toContain('actualDropDatabase');
      expect(normalized).toContain("'__STRING__'");
      expect(normalized).toContain('"__STRING__"');
    });
  });

  // =========================================
  // Identifier Extraction Tests  
  // 識別符提取測試
  // =========================================
  describe('extractIdentifiers', () => {
    it('should extract collection names from collection() calls', () => {
      const js = `
        db.collection('users').find();
        db.collection("orders").insertOne({});
      `;
      const ids = adapter.extractIdentifiers(js);
      expect(ids).toContain('users');
      expect(ids).toContain('orders');
    });

    it('should extract collection names from createCollection()', () => {
      const js = `
        await db.createCollection('products');
        await db.createCollection("categories");
      `;
      const ids = adapter.extractIdentifiers(js);
      expect(ids).toContain('products');
      expect(ids).toContain('categories');
    });

    it('should extract index names', () => {
      const js = `
        await db.collection('users').createIndex({ email: 1 }, { name: 'idx_email' });
        await db.collection('orders').createIndex({ date: -1 }, { name: "idx_date" });
      `;
      const ids = adapter.extractIdentifiers(js);
      expect(ids).toContain('idx_email');
      expect(ids).toContain('idx_date');
    });

    it('should extract variable names', () => {
      const js = `
        const dropDatabaseHelper = () => {};
        let removeAllUsers = async () => {};
        var deleteAllData = function() {};
      `;
      const ids = adapter.extractIdentifiers(js);
      expect(ids).toContain('dropDatabaseHelper');
      expect(ids).toContain('removeAllUsers');
      expect(ids).toContain('deleteAllData');
    });

    it('should remove duplicate identifiers', () => {
      const js = `
        db.collection('users').find();
        db.collection('users').insertOne({});
      `;
      const ids = adapter.extractIdentifiers(js);
      const usersCount = ids.filter(id => id === 'users').length;
      expect(usersCount).toBe(1);
    });
  });

  // =========================================
  // Suspicious Name Detection Tests
  // 可疑名稱檢測測試
  // =========================================
  describe('checkSuspiciousNames', () => {
    it('should detect suspicious collection names', () => {
      const js = `
        await db.createCollection('drop_database_log');
      `;
      const warnings = adapter.checkSuspiciousNames(js);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].identifier).toBe('drop_database_log');
    });

    it('should detect suspicious variable names', () => {
      const js = `
        const dropDatabaseHelper = () => {};
      `;
      const warnings = adapter.checkSuspiciousNames(js);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some(w => w.identifier === 'dropDatabaseHelper')).toBe(true);
    });

    it('should detect suspicious index names', () => {
      const js = `
        await db.collection('users').createIndex({ email: 1 }, { name: 'idx_shutdown_status' });
      `;
      const warnings = adapter.checkSuspiciousNames(js);
      expect(warnings.some(w => w.identifier === 'idx_shutdown_status')).toBe(true);
    });

    it('should not flag normal identifiers', () => {
      const js = `
        const helper = () => {};
        await db.createCollection('users');
        await db.collection('orders').createIndex({ date: 1 }, { name: 'idx_date' });
      `;
      const warnings = adapter.checkSuspiciousNames(js);
      expect(warnings.length).toBe(0);
    });

    it('should detect multiple suspicious names', () => {
      const js = `
        await db.createCollection('deleteall_logs');
        const dropDatabaseUtil = () => {};
        const removeAllHelper = async () => {};
      `;
      const warnings = adapter.checkSuspiciousNames(js);
      // Each identifier may match multiple keywords
      // 'deleteall_logs' matches 'deleteall', 'deleteall_logs' matches 'delete_all' (normalized)
      // 'dropDatabaseUtil' matches 'dropdatabase', 'drop_database'
      // 'removeAllHelper' matches 'removeall', 'remove_all'
      expect(warnings.length).toBeGreaterThanOrEqual(3);
      const identifiers = warnings.map(w => w.identifier);
      expect(identifiers).toContain('deleteall_logs');
      expect(identifiers).toContain('dropDatabaseUtil');
      expect(identifiers).toContain('removeAllHelper');
    });

    it('should include suspicious names in validateContent result', () => {
      const js = `
        export const up = async (db) => {
          await db.createCollection('drop_database_backup');
        };
        export const down = async (db) => {
          await db.collection('drop_database_backup').drop();
        };
      `;
      const result = adapter.validateContent(js, 'test.js');
      expect(result.suspiciousNames).toBeDefined();
      expect(result.suspiciousNames.length).toBeGreaterThan(0);
      expect(result.summary.suspiciousNames).toBeGreaterThan(0);
    });
  });

  // =========================================
  // Performance Issue Detection Tests
  // 效能問題檢測測試
  // =========================================
  describe('checkPerformanceIssues', () => {
    it('should detect too many indexes in one migration', () => {
      const js = `
        await db.collection('a').createIndex({ f1: 1 });
        await db.collection('b').createIndex({ f2: 1 });
        await db.collection('c').createIndex({ f3: 1 });
        await db.collection('d').createIndex({ f4: 1 });
        await db.collection('e').createIndex({ f5: 1 });
        await db.collection('f').createIndex({ f6: 1 });
      `;
      const result = adapter.checkPerformanceIssues(js);
      const tooManyIndexes = result.warnings.find(w => w.code === 'TOO_MANY_INDEXES');
      expect(tooManyIndexes).toBeDefined();
      expect(result.metrics.indexCount).toBe(6);
    });

    it('should detect multiple indexes on same collection', () => {
      const js = `
        await db.collection('users').createIndex({ email: 1 });
        await db.collection('users').createIndex({ name: 1 });
        await db.collection('users').createIndex({ createdAt: -1 });
      `;
      const result = adapter.checkPerformanceIssues(js);
      const multipleIndexes = result.warnings.find(w => w.code === 'MULTIPLE_INDEXES_SAME_COLLECTION');
      expect(multipleIndexes).toBeDefined();
      expect(multipleIndexes.collection).toBe('users');
    });

    it('should detect too many bulk operations', () => {
      const js = `
        await db.collection('a').insertMany([]);
        await db.collection('b').updateMany({}, {});
        await db.collection('c').deleteMany({});
        await db.collection('d').bulkWrite([]);
        await db.collection('e').insertMany([]);
        await db.collection('f').updateMany({}, {});
        await db.collection('g').deleteMany({});
        await db.collection('h').bulkWrite([]);
        await db.collection('i').insertMany([]);
        await db.collection('j').updateMany({}, {});
        await db.collection('k').deleteMany({});
      `;
      const result = adapter.checkPerformanceIssues(js);
      const tooManyBulkOps = result.warnings.find(w => w.code === 'TOO_MANY_BULK_OPS');
      expect(tooManyBulkOps).toBeDefined();
      expect(result.metrics.bulkOpsCount).toBe(11);
    });

    it('should detect too many $lookup stages', () => {
      const js = `
        await db.collection('orders').aggregate([
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
          { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', as: 'product' } },
          { $lookup: { from: 'shipping', localField: 'shippingId', foreignField: '_id', as: 'shipping' } },
          { $lookup: { from: 'payments', localField: 'paymentId', foreignField: '_id', as: 'payment' } }
        ]);
      `;
      const result = adapter.checkPerformanceIssues(js);
      const tooManyLookups = result.warnings.find(w => w.code === 'TOO_MANY_LOOKUPS');
      expect(tooManyLookups).toBeDefined();
      expect(result.metrics.lookupCount).toBe(4);
    });

    it('should detect complex aggregate pipelines', () => {
      const js = `
        await db.collection('orders').aggregate([
          { $match: { status: 'active' } },
          { $project: { _id: 1, total: 1 } },
          { $group: { _id: '$category', total: { $sum: '$total' } } },
          { $sort: { total: -1 } },
          { $limit: 10 },
          { $skip: 0 },
          { $unwind: '$items' },
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
          { $addFields: { fullName: { $concat: ['$firstName', ' ', '$lastName'] } } },
          { $set: { processed: true } },
          { $replaceRoot: { newRoot: '$data' } }
        ]);
      `;
      const result = adapter.checkPerformanceIssues(js);
      const complexPipeline = result.warnings.find(w => w.code === 'COMPLEX_AGGREGATE');
      expect(complexPipeline).toBeDefined();
      expect(result.metrics.pipelineStagesCount).toBeGreaterThan(10);
    });

    it('should detect migration file too long', () => {
      // Generate a very long migration
      const longCode = 'a'.repeat(51000);
      const result = adapter.checkPerformanceIssues(longCode);
      const tooLong = result.warnings.find(w => w.code === 'MIGRATION_TOO_LONG');
      expect(tooLong).toBeDefined();
      expect(result.metrics.totalLength).toBeGreaterThan(50000);
    });

    it('should not warn when within limits', () => {
      const js = `
        await db.collection('users').createIndex({ email: 1 });
        await db.collection('orders').insertMany([]);
      `;
      const result = adapter.checkPerformanceIssues(js);
      expect(result.warnings.length).toBe(0);
    });

    it('should include performance issues in validateContent result', () => {
      const js = `
        export const up = async (db) => {
          await db.collection('a').createIndex({ f1: 1 });
          await db.collection('b').createIndex({ f2: 1 });
          await db.collection('c').createIndex({ f3: 1 });
          await db.collection('d').createIndex({ f4: 1 });
          await db.collection('e').createIndex({ f5: 1 });
          await db.collection('f').createIndex({ f6: 1 });
        };
        export const down = async (db) => {};
      `;
      const result = adapter.validateContent(js, 'test.js');
      expect(result.performanceIssues).toBeDefined();
      expect(result.performanceIssues.length).toBeGreaterThan(0);
      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics.indexCount).toBe(6);
      expect(result.summary.performanceIssues).toBeGreaterThan(0);
    });

    it('should provide performance summary', () => {
      const js = `
        await db.collection('a').createIndex({ f1: 1 });
        await db.collection('b').createIndex({ f2: 1 });
        await db.collection('c').createIndex({ f3: 1 });
        await db.collection('d').createIndex({ f4: 1 });
        await db.collection('e').createIndex({ f5: 1 });
        await db.collection('f').createIndex({ f6: 1 });
      `;
      const result = adapter.checkPerformanceIssues(js);
      expect(result.summary).toBeDefined();
      expect(result.summary.totalWarnings).toBeGreaterThan(0);
      expect(result.summary.hasCriticalPerformanceIssues).toBe(true);
    });
  });

  describe('status() in DCL mode', () => {
    it('should return empty DDL result when mode is repeatable', async () => {
      const dclAdapter = new MongoDBAdapter({
        ...mockConfig,
        mode: 'repeatable'
      });
      const result = await dclAdapter.status();
      expect(result).toEqual({ pending: [], applied: [], total: 0 });
    });

    it('should NOT return early when mode is not repeatable (DDL mode)', async () => {
      // Default mockConfig has no mode field → DDL path → calls migrate-mongo status
      const { default: migrateMongo } = await import('migrate-mongo');
      migrateMongo.status.mockResolvedValueOnce([]);

      const ddlAdapter = new MongoDBAdapter({ ...mockConfig });
      ddlAdapter.db = {};
      const result = await ddlAdapter.status();

      expect(migrateMongo.status).toHaveBeenCalled();
      expect(result.pending).toEqual([]);
      expect(result.applied).toEqual([]);
    });

    it('should treat mode=repeatable as DCL regardless of other config', async () => {
      const dclAdapter = new MongoDBAdapter({
        mode: 'repeatable',
        checksumCollection: 'dcl_repeatable_migrations',
        mongodb: { url: 'mongodb://localhost:27017', databaseName: 'mydb', options: {} }
      });
      const result = await dclAdapter.status();
      expect(result.pending).toEqual([]);
      expect(result.applied).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('validateContent() — mode-aware validation', () => {
    describe('DDL mode (versioned, default)', () => {
      it('should forbid createUser in DDL migration', () => {
        const js = `
export const up = async (db) => { await db.command({ createUser: 'app', pwd: 'secret', roles: [] }); };
export const down = async (db) => {};
`;
        const result = adapter.validateContent(js, '20260101_add_user.js');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER_CMD')).toBe(true);
      });

      it('should forbid grantRolesToUser in DDL migration', () => {
        const js = `
export const up = async (db) => { await db.command({ grantRolesToUser: 'app', roles: ['read'] }); };
export const down = async (db) => {};
`;
        const result = adapter.validateContent(js, '20260101_grant.js');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'GRANT_ROLES_CMD')).toBe(true);
      });
    });

    describe('DCL mode (repeatable)', () => {
      let dclAdapter;
      beforeEach(() => {
        dclAdapter = new MongoDBAdapter({ ...mockConfig, mode: 'repeatable' });
      });

      it('should NOT forbid createUser in DCL migration', () => {
        const js = `
export const up = async (db) => { await db.command({ createUser: 'app', pwd: 'secret', roles: [] }); };
export const down = async (db) => {};
`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['CREATE_USER', 'CREATE_USER_CMD'].includes(op.code))).toBe(false);
      });

      it('should forbid dropUser in DCL migration (dclHighRisk)', () => {
        const js = `export const up = async (db) => { await db.command({ dropUser: 'app' }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['DROP_USER', 'DROP_USER_CMD'].includes(op.code))).toBe(true);
      });

      it('should allow dropUser with // @allow-forbidden: true annotation', () => {
        const js = `// @allow-forbidden: true\nexport const up = async (db) => { await db.command({ dropUser: 'app' }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['DROP_USER', 'DROP_USER_CMD'].includes(op.code))).toBe(false);
      });

      it('should allow db.dropUser() with // @allow-forbidden: true annotation', () => {
        const js = `// @allow-forbidden: true\nexport const up = async (db) => { await db.dropUser('app'); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(false);
      });

      it('should forbid updateUser in DCL migration (dclHighRisk — password change)', () => {
        const js = `export const up = async (db) => { await db.command({ updateUser: 'app', pwd: 'newpass' }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['UPDATE_USER', 'UPDATE_USER_CMD'].includes(op.code))).toBe(true);
      });

      it('should allow updateUser with // @allow-forbidden: true annotation', () => {
        const js = `// @allow-forbidden: true\nexport const up = async (db) => { await db.command({ updateUser: 'app', pwd: 'newpass' }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['UPDATE_USER', 'UPDATE_USER_CMD'].includes(op.code))).toBe(false);
      });

      it('should NOT allow createCollection bypass with annotation (dclReverse is absolute)', () => {
        const js = `// @allow-forbidden: true\nexport const up = async (db) => { await db.createCollection('users'); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_bad.js');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_COLLECTION_IN_DCL')).toBe(true);
      });

      it('should forbid renameCollection command form in DCL migration (dclReverse)', () => {
        const js = `export const up = async (db) => { await db.command({ renameCollection: 'test.old', to: 'test.new' }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_bad.js');
        expect(result.forbiddenOps.some(op => op.code === 'RENAME_COLLECTION_IN_DCL_CMD')).toBe(true);
      });

      it('should pass a full idiomatic R__ file: createUser + grantRolesToUser', () => {
        const js = [
          `// @allow-forbidden: true`,
          `export const up = async (db) => {`,
          `  await db.command({ dropUser: 'app' });`,
          `  await db.command({ createUser: 'app', pwd: 'secret', roles: [{ role: 'read', db: 'mydb' }] });`,
          `  await db.command({ grantRolesToUser: 'app', roles: [{ role: 'read', db: 'mydb' }] });`,
          `};`
        ].join('\n') + '\n';
        const result = dclAdapter.validateContent(js, 'R__001_drop_create.js');
        expect(result.forbiddenOps.some(op => ['DROP_USER', 'DROP_USER_CMD'].includes(op.code))).toBe(false);
        expect(result.forbiddenOps.some(op => ['CREATE_USER', 'CREATE_USER_CMD'].includes(op.code))).toBe(false);
      });

      it('should NOT forbid grantRolesToUser in DCL migration', () => {
        const js = `export const up = async (db) => { await db.command({ grantRolesToUser: 'app', roles: ['read'] }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.forbiddenOps.some(op => ['GRANT_ROLES', 'GRANT_ROLES_CMD'].includes(op.code))).toBe(false);
      });

      it('should forbid createCollection in DCL migration (dclReverse)', () => {
        const js = `export const up = async (db) => { await db.createCollection('users'); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_bad.js');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_COLLECTION_IN_DCL')).toBe(true);
      });

      it('should forbid createIndex in DCL migration (dclReverse)', () => {
        const js = `export const up = async (db) => { await db.collection('users').createIndex({ email: 1 }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_bad.js');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_INDEX_IN_DCL')).toBe(true);
      });

      it('should NOT emit missing-down error for R__ file', () => {
        const js = `export const up = async (db) => { await db.command({ createUser: 'app', pwd: 'x', roles: [] }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_app_user.js');
        expect(result.errors.some(e => e.type === 'missing-down')).toBe(false);
      });

      it('should still block dangerous ops like deleteMany in DCL mode', () => {
        const js = `export const up = async (db) => { await db.collection('audit').deleteMany({}); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_cleanup.js');
        expect(result.dangerousOps.some(op => op.code === 'DELETE_ALL')).toBe(true);
      });

      it('should still block system-level forbidden ops in DCL mode', () => {
        const js = `export const up = async (db) => { await db.command({ shutdown: true }); };\n`;
        const result = dclAdapter.validateContent(js, 'R__001_bad.js');
        expect(result.forbiddenOps.some(op => op.code === 'SHUTDOWN')).toBe(true);
      });
    });
  });
});
