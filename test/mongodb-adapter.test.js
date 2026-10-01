/**
 * MongoDB Adapter Tests with Sanity Check
 * 測試 MongoDB 遷移適配器的 Sanity Check 功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

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
    down: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue('20260101000000-migration.js')
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
      // Default mockConfig has no mode field → DDL path → reads files + changelog itself
      const { default: migrateMongo } = await import('migrate-mongo');

      // status() now also reads migrationsDir directly (Gate R1's orphan/
      // order checks) and queries the changelog collection for orphan
      // detection — needs a real, guaranteed-empty dir and a minimal db mock.
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-empty-'));
      const ddlAdapter = new MongoDBAdapter({ ...mockConfig, migrationsDir: emptyDir });
      ddlAdapter.db = { collection: vi.fn(() => ({ find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([]) })) })) };
      const result = await ddlAdapter.status();
      await fs.rm(emptyDir, { recursive: true, force: true });

      // migrate-mongo's status() can't exclude R__ files, so it isn't used
      expect(migrateMongo.status).not.toHaveBeenCalled();
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

  describe('status() — DDL checksum verification', () => {
    let tmpDir;
    let ddlAdapter;
    const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-checksum-'));
      ddlAdapter = new MongoDBAdapter({ ...mockConfig, migrationsDir: tmpDir });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // Minimal `db` mock: find()/toArray() returns the given checksum docs,
    // updateOne() is spy-able for the backfill/mismatch-repair assertions.
    function mockDb({ docs = [], updateSpy = vi.fn().mockResolvedValue({}) } = {}) {
      return {
        collection: vi.fn(() => ({
          find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(docs) })),
          updateOne: updateSpy
        }))
      };
    }

    it('reports no mismatch when the stored checksum matches the current file content', async () => {
      const content = `export async function up(db, client) { await db.createCollection('foo'); }\nexport async function down(db, client) { await db.collection('foo').drop(); }\n`;
      await fs.writeFile(path.join(tmpDir, '20260101000000-create-foo.js'), content, 'utf-8');
      ddlAdapter.db = mockDb({ docs: [{ fileName: '20260101000000-create-foo.js', checksum: sha256(content) }] });

      const status = await ddlAdapter.status();

      expect(status.checksumMismatches).toEqual([]);
      expect(status.checksumBaselined).toEqual([]);
    });

    it('detects a checksum mismatch when an applied migration file was edited afterward', async () => {
      const editedContent = `export async function up(db, client) { await db.createCollection('foo'); await db.collection('foo').createIndex({ x: 1 }); }\nexport async function down(db, client) { await db.collection('foo').drop(); }\n`;
      const originalChecksum = sha256(`export async function up(db, client) { await db.createCollection('foo'); }\n`);
      await fs.writeFile(path.join(tmpDir, '20260101000000-create-foo.js'), editedContent, 'utf-8');
      ddlAdapter.db = mockDb({ docs: [{ fileName: '20260101000000-create-foo.js', checksum: originalChecksum }] });

      const status = await ddlAdapter.status();

      expect(status.checksumMismatches).toHaveLength(1);
      expect(status.checksumMismatches[0].fileName).toBe('20260101000000-create-foo.js');
    });

    it('adopts the current file content as the baseline when no checksum is stored yet, without flagging a mismatch', async () => {
      const content = `export async function up(db, client) { await db.createCollection('foo'); }\n`;
      await fs.writeFile(path.join(tmpDir, '20260101000000-create-foo.js'), content, 'utf-8');
      const updateSpy = vi.fn().mockResolvedValue({});
      ddlAdapter.db = mockDb({ docs: [{ fileName: '20260101000000-create-foo.js' /* no checksum field */ }], updateSpy });

      const status = await ddlAdapter.status();

      expect(status.checksumMismatches).toEqual([]);
      expect(status.checksumBaselined).toEqual(['20260101000000-create-foo.js']);
      expect(updateSpy).toHaveBeenCalledWith(
        { fileName: '20260101000000-create-foo.js' },
        { $set: { checksum: sha256(content) } }
      );
    });
  });

  describe('status() — Gate R1 orphaned-entry and out-of-order checks', () => {
    let tmpDir;
    let ddlAdapter;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-r1-'));
      ddlAdapter = new MongoDBAdapter({ ...mockConfig, migrationsDir: tmpDir });
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function mockDb(allDocs) {
      return {
        collection: vi.fn(() => ({
          find: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(allDocs) }))
        }))
      };
    }

    it('flags a changelog doc whose file no longer exists on disk as orphaned', async () => {
      // No files written to tmpDir — the changelog doc has no file behind it.
      ddlAdapter.db = mockDb([{ fileName: '20260101000000-deleted-file.js', appliedAt: new Date() }]);

      const status = await ddlAdapter.status();

      expect(status.orphanedChangelogEntries).toEqual([
        { id: '20260101000000-deleted-file.js', appliedAt: expect.any(Date) }
      ]);
    });

    it('does not flag a doc as orphaned when its file is present', async () => {
      await fs.writeFile(path.join(tmpDir, '20260101000000-create-foo.js'), 'export async function up(db) {}\n', 'utf-8');
      ddlAdapter.db = mockDb([{ fileName: '20260101000000-create-foo.js', appliedAt: new Date(), checksum: 'x' }]);

      const status = await ddlAdapter.status();

      expect(status.orphanedChangelogEntries).toEqual([]);
    });

    it('flags a later-sorted file as out-of-order when an earlier-sorted file is still pending', async () => {
      await fs.writeFile(path.join(tmpDir, '20260101000000-a.js'), 'export async function up(db) {}\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, '20260101000001-b.js'), 'export async function up(db) {}\n', 'utf-8');
      ddlAdapter.db = mockDb([{ fileName: '20260101000001-b.js', checksum: 'x' }]);

      const status = await ddlAdapter.status();

      expect(status.outOfOrderApplied).toEqual(['20260101000001-b.js']);
      expect(status.pending).toEqual(['20260101000000-a.js']);
    });

    it('does not flag anything out-of-order when applied migrations form a contiguous prefix', async () => {
      await fs.writeFile(path.join(tmpDir, '20260101000000-a.js'), 'export async function up(db) {}\n', 'utf-8');
      await fs.writeFile(path.join(tmpDir, '20260101000001-b.js'), 'export async function up(db) {}\n', 'utf-8');
      ddlAdapter.db = mockDb([{ fileName: '20260101000000-a.js', checksum: 'x' }]);

      const status = await ddlAdapter.status();

      expect(status.outOfOrderApplied).toEqual([]);
      expect(status.pending).toEqual(['20260101000001-b.js']);
    });
  });

  describe('repairChecksum()', () => {
    it('repairChecksum() reads the current file content and writes its checksum', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-repair-'));
      try {
        const content = `export async function up(db, client) { await db.collection('foo').createIndex({ y: 1 }); }\n`;
        await fs.writeFile(path.join(tmpDir, '20260101000001-add-index.js'), content, 'utf-8');

        const adapterUnderTest = new MongoDBAdapter({ ...mockConfig, migrationsDir: tmpDir });
        const updateSpy = vi.fn().mockResolvedValue({});
        adapterUnderTest.db = { collection: vi.fn(() => ({ updateOne: updateSpy })) };

        const checksum = await adapterUnderTest.repairChecksum('20260101000001-add-index.js');

        expect(checksum).toBe(crypto.createHash('sha256').update(content, 'utf8').digest('hex'));
        expect(updateSpy).toHaveBeenCalledWith(
          { fileName: '20260101000001-add-index.js' },
          { $set: { checksum } }
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('connect() — Gate R0 identity check', () => {
    it('passes connectTimeoutMS/serverSelectionTimeoutMS defaults through to migrate-mongo config', async () => {
      const migrateMongoMock = (await import('migrate-mongo')).default;
      migrateMongoMock.database.connect.mockResolvedValueOnce({
        client: { close: vi.fn() },
        db: { databaseName: 'test' } // mockConfig's databaseName is 'test'
      });

      const testAdapter = new MongoDBAdapter({ ...mockConfig });
      await testAdapter.connect();

      const configArg = migrateMongoMock.config.set.mock.calls.at(-1)[0];
      expect(configArg.mongodb.options.connectTimeoutMS).toBeTypeOf('number');
      expect(configArg.mongodb.options.serverSelectionTimeoutMS).toBeTypeOf('number');
    });

    it('succeeds when the connection reports the expected database', async () => {
      const migrateMongoMock = (await import('migrate-mongo')).default;
      const closeSpy = vi.fn();
      migrateMongoMock.database.connect.mockResolvedValueOnce({
        client: { close: closeSpy },
        db: { databaseName: 'test' }
      });

      const testAdapter = new MongoDBAdapter({ ...mockConfig });
      const result = await testAdapter.connect();

      expect(result.db.databaseName).toBe('test');
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('refuses to proceed and closes the client when the reported database does not match config', async () => {
      const migrateMongoMock = (await import('migrate-mongo')).default;
      const closeSpy = vi.fn();
      migrateMongoMock.database.connect.mockResolvedValueOnce({
        client: { close: closeSpy },
        db: { databaseName: 'some_other_db' } // mismatch vs mockConfig's 'test'
      });

      const testAdapter = new MongoDBAdapter({ ...mockConfig });

      await expect(testAdapter.connect()).rejects.toThrow(/wrong database/i);
      expect(closeSpy).toHaveBeenCalled();
      expect(testAdapter.db).toBeNull();
      expect(testAdapter.client).toBeNull();
    });
  });

  describe('validateContent() — mode-aware validation', () => {
    describe('JS syntax and export interface checks', () => {
      it('should fail on JavaScript syntax error', () => {
        const js = `export const up = async (db) => { await db.collection('x').insertOne({});`;
        const result = adapter.validateContent(js, 'bad-syntax.js');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === 'JS_SYNTAX_ERROR')).toBe(true);
      });

      it('should fail when up() export is missing', () => {
        const js = `export const down = async (db) => { await db.collection('x').drop(); };`;
        const result = adapter.validateContent(js, 'missing-up.js');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === 'MISSING_UP_EXPORT')).toBe(true);
      });

      it('should fail in versioned mode when down() export is missing', () => {
        const js = `export const up = async (db) => { await db.createCollection('users'); };`;
        const result = adapter.validateContent(js, 'missing-down.js');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === 'MISSING_DOWN_EXPORT')).toBe(true);
      });

      it('should allow missing down() export in repeatable mode', () => {
        const dclAdapter = new MongoDBAdapter({ ...mockConfig, mode: 'repeatable' });
        const js = `export const up = async (db) => { await db.command({ createUser: 'app', pwd: 'x', roles: [] }); };`;
        const result = dclAdapter.validateContent(js, 'R__001_users.js');
        expect(result.errors.some(e => e.code === 'MISSING_DOWN_EXPORT')).toBe(false);
      });
    });

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

  describe('create templates with sanity scaffolding', () => {
    it('should enrich create() output with preCheck/postCheck scaffolding', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mongo-create-'));
      const fileName = '20260327000000-add-users.js';

      const { default: migrateMongo } = await import('migrate-mongo');
      migrateMongo.create.mockResolvedValueOnce(fileName);

      const localAdapter = new MongoDBAdapter({
        ...mockConfig,
        migrationsDir: tmpDir,
        mongodb: {
          ...mockConfig.mongodb,
          databaseName: 'unit_test_db'
        }
      });

      const generatedPath = path.join(tmpDir, fileName);
      await fs.writeFile(generatedPath, '// placeholder generated by migrate-mongo');

      const created = await localAdapter.create('add-users');
      const content = await fs.readFile(generatedPath, 'utf-8');

      expect(created).toBe(fileName);
      expect(content).toContain('export async function preCheck');
      expect(content).toContain('export async function postCheck');
      expect(content).toContain('export async function up');
      expect(content).toContain('export async function down');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should generate DCL template with preCheck/postCheck scaffolding', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mongo-createdcl-'));

      const localAdapter = new MongoDBAdapter({
        ...mockConfig,
        migrationsDir: tmpDir,
        mode: 'repeatable',
        mongodb: {
          ...mockConfig.mongodb,
          databaseName: 'unit_test_db'
        }
      });

      const fileName = await localAdapter.createDCL('dcl-user-setup', '001');
      const content = await fs.readFile(path.join(tmpDir, fileName), 'utf-8');

      expect(content).toContain('export async function preCheck');
      expect(content).toContain('export async function postCheck');
      expect(content).toContain('export async function up');
      expect(content).toContain('export async function down');

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('resetChangelog', () => {
    function mockDb(count) {
      const deleteMany = vi.fn().mockResolvedValue({ deletedCount: count });
      const countDocuments = vi.fn().mockResolvedValue(count);
      return {
        db: { collection: vi.fn().mockReturnValue({ countDocuments, deleteMany }) },
        countDocuments,
        deleteMany
      };
    }

    it('dry run counts documents but issues no deleteMany', async () => {
      const m = mockDb(4);
      adapter.db = m.db;
      const count = await adapter.resetChangelog({ dryRun: true });
      expect(count).toBe(4);
      expect(m.countDocuments).toHaveBeenCalledTimes(1);
      expect(m.deleteMany).not.toHaveBeenCalled();
    });

    it('actual run deletes and returns the pre-deletion count', async () => {
      const m = mockDb(6);
      adapter.db = m.db;
      const count = await adapter.resetChangelog({ dryRun: false });
      expect(count).toBe(6);
      expect(m.deleteMany).toHaveBeenCalledTimes(1);
      expect(m.deleteMany).toHaveBeenCalledWith({});
    });

    it('skips deleteMany entirely when there is nothing to delete', async () => {
      const m = mockDb(0);
      adapter.db = m.db;
      const count = await adapter.resetChangelog({ dryRun: false });
      expect(count).toBe(0);
      expect(m.deleteMany).not.toHaveBeenCalled();
    });

    it('defaults to this.changelogCollection when no collectionName is given', async () => {
      const m = mockDb(1);
      adapter.db = m.db;
      adapter.changelogCollection = 'custom_changelog';
      await adapter.resetChangelog({ dryRun: true });
      expect(m.db.collection).toHaveBeenCalledWith('custom_changelog');
    });

    it('uses the passed collectionName for DCL checksum collections instead of the changelog collection', async () => {
      const m = mockDb(2);
      adapter.db = m.db;
      await adapter.resetChangelog({ dryRun: true, collectionName: 'repeatable_migrations' });
      expect(m.db.collection).toHaveBeenCalledWith('repeatable_migrations');
    });
  });

  describe('getSchemaSnapshot', () => {
    function mockCollection({ count, indexes, sample }) {
      return {
        estimatedDocumentCount: vi.fn().mockResolvedValue(count),
        indexes: vi.fn().mockResolvedValue(indexes.map(name => ({ name }))),
        findOne: vi.fn().mockResolvedValue(sample)
      };
    }

    it('returns one entry per collection with indexes and inferred field types', async () => {
      const usersColl = mockCollection({
        count: 10,
        indexes: ['_id_', 'email_1'],
        sample: { _id: 'abc', email: 'a@b.com', age: 30, createdAt: new Date('2026-01-01'), tags: ['x'], profile: { bio: 'hi' } }
      });
      const ordersColl = mockCollection({ count: 0, indexes: ['_id_'], sample: null });

      adapter.db = {
        listCollections: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'users' }, { name: 'orders' }]) }),
        collection: vi.fn().mockImplementation((name) => (name === 'users' ? usersColl : ordersColl))
      };

      const snapshot = await adapter.getSchemaSnapshot();

      expect(snapshot).toHaveLength(2);
      expect(snapshot[0]).toMatchObject({ collection: 'users', count: 10, indexes: ['_id_', 'email_1'] });
      const fieldTypes = Object.fromEntries(snapshot[0].fields.map(f => [f.name, f.type]));
      expect(fieldTypes.email).toBe('string');
      expect(fieldTypes.age).toBe('number');
      expect(fieldTypes.createdAt).toBe('date');
      expect(fieldTypes.tags).toBe('array');
      expect(fieldTypes.profile).toBe('object');
    });

    it('returns an empty fields array for an empty collection instead of throwing', async () => {
      const emptyColl = mockCollection({ count: 0, indexes: ['_id_'], sample: null });
      adapter.db = {
        listCollections: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([{ name: 'empty' }]) }),
        collection: vi.fn().mockReturnValue(emptyColl)
      };
      const snapshot = await adapter.getSchemaSnapshot();
      expect(snapshot[0].fields).toEqual([]);
    });

    it('returns an empty array when there are no collections', async () => {
      adapter.db = {
        listCollections: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        collection: vi.fn()
      };
      const snapshot = await adapter.getSchemaSnapshot();
      expect(snapshot).toEqual([]);
      expect(adapter.db.collection).not.toHaveBeenCalled();
    });
  });
});
