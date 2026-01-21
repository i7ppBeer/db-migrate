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
});
