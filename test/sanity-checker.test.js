/**
 * Sanity Checker Unit Tests
 * 測試 Pre-Check / Post-Check / Auto-Rollback 機制
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SanityChecker, MongoDBChecks, SQLChecks } from '../src/core/sanity-checker.js';

describe('SanityChecker', () => {
  let sanityChecker;
  let mockReporter;

  beforeEach(() => {
    mockReporter = {
      log: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn()
    };
    sanityChecker = new SanityChecker({ reporter: mockReporter });
  });

  describe('runWithSanityCheck', () => {
    it('should execute migration successfully when all checks pass', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true, details: ['Pre-check passed'] }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ success: true, details: ['Post-check passed'] }),
        down: vi.fn().mockResolvedValue(undefined)
      };

      const context = { db: {}, client: {} };
      const result = await sanityChecker.runWithSanityCheck(migration, context);

      expect(result.success).toBe(true);
      expect(result.preCheckResult.success).toBe(true);
      expect(result.postCheckResult.success).toBe(true);
      expect(result.migrationExecuted).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(migration.up).toHaveBeenCalledOnce();
      expect(migration.down).not.toHaveBeenCalled();
    });

    it('should skip migration when preCheck fails', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Precondition not met' 
        }),
        up: vi.fn(),
        postCheck: vi.fn(),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      const result = await sanityChecker.runWithSanityCheck(migration, context);

      expect(result.success).toBe(false);
      expect(result.preCheckResult.success).toBe(false);
      expect(result.migrationExecuted).toBe(false);
      expect(migration.up).not.toHaveBeenCalled();
    });

    it('should auto-rollback when postCheck fails and autoRollback is true', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Sanity check failed' 
        }),
        down: vi.fn().mockResolvedValue(undefined)
      };

      const context = { db: {}, client: {} };
      const options = { autoRollback: true };
      const result = await sanityChecker.runWithSanityCheck(migration, context, options);

      expect(result.success).toBe(false);
      expect(result.migrationExecuted).toBe(true);
      expect(result.rolledBack).toBe(true);
      expect(migration.down).toHaveBeenCalledOnce();
    });

    it('should NOT auto-rollback when autoRollback is false', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ 
          success: false, 
          error: 'Sanity check failed' 
        }),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      const options = { autoRollback: false };
      const result = await sanityChecker.runWithSanityCheck(migration, context, options);

      expect(result.success).toBe(false);
      expect(result.migrationExecuted).toBe(true);
      expect(result.rolledBack).toBe(false);
      expect(migration.down).not.toHaveBeenCalled();
    });

    it('should skip preCheck if not defined', async () => {
      const migration = {
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ success: true }),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      const result = await sanityChecker.runWithSanityCheck(migration, context);

      expect(result.success).toBe(true);
      expect(result.preCheckResult).toBeNull();
      expect(migration.up).toHaveBeenCalledOnce();
    });

    it('should skip postCheck if not defined', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      const result = await sanityChecker.runWithSanityCheck(migration, context);

      expect(result.success).toBe(true);
      expect(result.postCheckResult).toBeNull();
      expect(migration.up).toHaveBeenCalledOnce();
    });

    it('should handle migration execution error', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockRejectedValue(new Error('Migration failed')),
        postCheck: vi.fn(),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      
      await expect(sanityChecker.runWithSanityCheck(migration, context))
        .rejects.toThrow('Migration failed');
    });

    it('should timeout preCheck if it takes too long', async () => {
      const migration = {
        preCheck: vi.fn().mockImplementation(() => 
          new Promise(resolve => setTimeout(() => resolve({ success: true }), 5000))
        ),
        up: vi.fn(),
        postCheck: vi.fn(),
        down: vi.fn()
      };

      const context = { db: {}, client: {} };
      const options = { timeout: 100 }; // 100ms timeout
      
      const result = await sanityChecker.runWithSanityCheck(migration, context, options);
      
      expect(result.success).toBe(false);
      expect(result.preCheckResult.success).toBe(false);
      expect(result.preCheckResult.error).toContain('timed out');
    });

    it('should report rollback failure', async () => {
      const migration = {
        preCheck: vi.fn().mockResolvedValue({ success: true }),
        up: vi.fn().mockResolvedValue(undefined),
        postCheck: vi.fn().mockResolvedValue({ success: false, error: 'Check failed' }),
        down: vi.fn().mockRejectedValue(new Error('Rollback failed'))
      };

      const context = { db: {}, client: {} };
      const options = { autoRollback: true };
      
      const result = await sanityChecker.runWithSanityCheck(migration, context, options);
      
      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.rollbackError).toBeDefined();
      expect(result.rollbackError.message).toBe('Rollback failed');
    });
  });

  describe('Configuration', () => {
    it('should use default options when none provided', () => {
      const checker = new SanityChecker();
      expect(checker.options.timeout).toBe(30000);
      expect(checker.options.autoRollback).toBe(true);
    });

    it('should merge custom options', () => {
      const checker = new SanityChecker({
        timeout: 60000,
        autoRollback: false
      });
      expect(checker.options.timeout).toBe(60000);
      expect(checker.options.autoRollback).toBe(false);
    });
  });
});

describe('MongoDBChecks', () => {
  describe('collectionExists', () => {
    it('should return true when collection exists', async () => {
      const mockDb = {
        listCollections: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([{ name: 'users' }])
        })
      };

      const result = await MongoDBChecks.collectionExists(mockDb, 'users');
      expect(result).toBe(true);
    });

    it('should return false when collection does not exist', async () => {
      const mockDb = {
        listCollections: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([])
        })
      };

      const result = await MongoDBChecks.collectionExists(mockDb, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('indexExists', () => {
    it('should return true when index exists', async () => {
      const mockCollection = {
        indexes: vi.fn().mockResolvedValue([
          { name: '_id_' },
          { name: 'email_1' }
        ])
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.indexExists(mockDb, 'users', 'email_1');
      expect(result).toBe(true);
    });

    it('should return false when index does not exist', async () => {
      const mockCollection = {
        indexes: vi.fn().mockResolvedValue([
          { name: '_id_' }
        ])
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.indexExists(mockDb, 'users', 'nonexistent_1');
      expect(result).toBe(false);
    });
  });

  describe('documentCount', () => {
    it('should return correct document count', async () => {
      const mockCollection = {
        countDocuments: vi.fn().mockResolvedValue(42)
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.documentCount(mockDb, 'users', { status: 'active' });
      expect(result).toBe(42);
      expect(mockCollection.countDocuments).toHaveBeenCalledWith({ status: 'active' });
    });

    it('should count all documents when no filter provided', async () => {
      const mockCollection = {
        countDocuments: vi.fn().mockResolvedValue(100)
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.documentCount(mockDb, 'users');
      expect(result).toBe(100);
      expect(mockCollection.countDocuments).toHaveBeenCalledWith({});
    });
  });

  describe('hasField', () => {
    it('should return true when field exists in all documents', async () => {
      const mockCollection = {
        countDocuments: vi.fn().mockResolvedValue(0)
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.hasField(mockDb, 'users', 'email');
      expect(result).toBe(true);
      expect(mockCollection.countDocuments).toHaveBeenCalledWith({ email: { $exists: false } });
    });

    it('should return false when some documents are missing the field', async () => {
      const mockCollection = {
        countDocuments: vi.fn().mockResolvedValue(5)
      };
      const mockDb = {
        collection: vi.fn().mockReturnValue(mockCollection)
      };

      const result = await MongoDBChecks.hasField(mockDb, 'users', 'phone');
      expect(result).toBe(false);
    });
  });
});

describe('SQLChecks', () => {
  describe('tableExists', () => {
    it('should return true when table exists', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 1 }]])
      };

      const result = await SQLChecks.tableExists(mockConnection, 'users');
      expect(result).toBe(true);
    });

    it('should return false when table does not exist', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 0 }]])
      };

      const result = await SQLChecks.tableExists(mockConnection, 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('columnExists', () => {
    it('should return true when column exists', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 1 }]])
      };

      const result = await SQLChecks.columnExists(mockConnection, 'users', 'email');
      expect(result).toBe(true);
    });

    it('should return false when column does not exist', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 0 }]])
      };

      const result = await SQLChecks.columnExists(mockConnection, 'users', 'nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('indexExists', () => {
    it('should return true when index exists', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 1 }]])
      };

      const result = await SQLChecks.indexExists(mockConnection, 'users', 'idx_email');
      expect(result).toBe(true);
    });
  });

  describe('rowCount', () => {
    it('should return correct row count', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 42 }]])
      };

      const result = await SQLChecks.rowCount(mockConnection, 'users', 'status = ?', ['active']);
      expect(result).toBe(42);
    });

    it('should count all rows when no where clause', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValue([[{ count: 100 }]])
      };

      const result = await SQLChecks.rowCount(mockConnection, 'users');
      expect(result).toBe(100);
    });
  });
});
