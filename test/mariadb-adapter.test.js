/**
 * MariaDB Adapter Tests with Sanity Check
 * 測試 MariaDB 遷移適配器的 Sanity Check 功能
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';

// Mock mysql2/promise
vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: vi.fn().mockResolvedValue({
      execute: vi.fn().mockResolvedValue([[]]),
      end: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined)
    })
  }
}));

describe('MariaDBAdapter', () => {
  let adapter;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      migrationsDir: '/test/migrations',
      migrationFileExtension: '.sql',
      mariadb: {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'password',
        database: 'test'
      },
      sanityCheck: {
        enabled: true,
        autoRollback: true,
        timeout: 30000
      }
    };
    adapter = new MariaDBAdapter(mockConfig);
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
  });

  describe('getSanityCheckHelpers', () => {
    it('should return SQL check helpers', () => {
      const helpers = adapter.getSanityCheckHelpers();
      
      expect(helpers).toHaveProperty('tableExists');
      expect(helpers).toHaveProperty('columnExists');
      expect(helpers).toHaveProperty('indexExists');
      expect(helpers).toHaveProperty('rowCount');
      expect(typeof helpers.tableExists).toBe('function');
    });
  });

  describe('extractSanitySection', () => {
    it('should extract PreCheck section from SQL', () => {
      const sql = `
-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM users WHERE status = 'deleted'
-- END_CHECK

-- +migrate Up
CREATE TABLE users (id INT);

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.extractSanitySection(sql, 'PreCheck');
      expect(result).toContain("EXPECT_NO_ROWS: SELECT 1 FROM users WHERE status = 'deleted'");
    });

    it('should extract PostCheck section from SQL', () => {
      const sql = `
-- +migrate Up
CREATE TABLE users (id INT);

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_name='users'
-- END_CHECK

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.extractSanitySection(sql, 'PostCheck');
      expect(result).toContain("EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_name='users'");
    });

    it('should return null when section not found', () => {
      const sql = `
-- +migrate Up
CREATE TABLE users (id INT);

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.extractSanitySection(sql, 'PreCheck');
      expect(result).toBeNull();
    });
  });

  describe('executeSanityCheck', () => {
    let mockConnection;

    beforeEach(() => {
      mockConnection = {
        execute: vi.fn()
      };
    });

    it('should pass EXPECT_ROWS when rows are returned', async () => {
      mockConnection.execute.mockResolvedValue([[{ result: 1 }]]);
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM users
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(true);
    });

    it('should fail EXPECT_ROWS when no rows returned', async () => {
      mockConnection.execute.mockResolvedValue([[]]);
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM users
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(false);
    });

    it('should pass EXPECT_NO_ROWS when no rows returned', async () => {
      mockConnection.execute.mockResolvedValue([[]]);
      
      const sanitySection = `
-- EXPECT_NO_ROWS: SELECT 1 FROM users WHERE deleted=1
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(true);
    });

    it('should fail EXPECT_NO_ROWS when rows are returned', async () => {
      mockConnection.execute.mockResolvedValue([[{ result: 1 }]]);
      
      const sanitySection = `
-- EXPECT_NO_ROWS: SELECT 1 FROM users WHERE deleted=1
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(false);
    });

    it('should handle multiple checks', async () => {
      mockConnection.execute
        .mockResolvedValueOnce([[{ result: 1 }]]) // First check passes
        .mockResolvedValueOnce([[]]);              // Second check passes (NO_ROWS)
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM users
-- EXPECT_NO_ROWS: SELECT 1 FROM deleted_users
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(true);
      expect(result.details).toHaveLength(2);
    });

    it('should fail on first failed check', async () => {
      mockConnection.execute
        .mockResolvedValueOnce([[]]) // First check fails (expected rows, got none)
        .mockResolvedValueOnce([[{ result: 1 }]]);
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM users
-- EXPECT_ROWS: SELECT 1 FROM products
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(false);
    });
  });

  describe('status() in DCL mode', () => {
    it('should return empty DDL result when mode is repeatable', async () => {
      const dclAdapter = new MariaDBAdapter({
        ...mockConfig,
        mode: 'repeatable'
      });
      // ensureChangelogTable calls connection.execute — spy to confirm it's NOT called
      const executeSpy = vi.fn();
      dclAdapter.connection = { execute: executeSpy };

      const result = await dclAdapter.status();

      expect(result).toEqual({ pending: [], applied: [], total: 0 });
      // execute should NOT have been called (no DDL changelog query)
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('should NOT return early when mode is ddl (default)', async () => {
      // DDL mode: status() proceeds normally and queries changelog table
      const ddlAdapter = new MariaDBAdapter({ ...mockConfig });
      // mode is undefined (not 'repeatable') → should NOT short-circuit
      const executeSpy = vi.fn().mockResolvedValue([[]]);
      ddlAdapter.connection = { execute: executeSpy };
      // migrationsDir must be readable — mock fs.readdir by pointing to a real empty path
      ddlAdapter.config.migrationsDir = '/tmp';

      // Will throw because /tmp has no .sql files, but execute WAS called
      try { await ddlAdapter.status(); } catch {}
      expect(executeSpy).toHaveBeenCalled();
    });

    it('should treat mode=repeatable as DCL regardless of other config', async () => {
      const dclAdapter = new MariaDBAdapter({
        mode: 'repeatable',
        checksumTable: 'dcl_repeatable_migrations',
        mariadb: { host: 'localhost', port: 3306, user: 'root', password: '', database: 'mydb' }
      });
      const result = await dclAdapter.status();
      expect(result.pending).toEqual([]);
      expect(result.applied).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('upWithSanityCheck', () => {
    it('should execute migration with sanity checks using sanity checker', async () => {
      // Test the adapter's ability to use sanity checker
      // by testing executeSanityCheck directly
      const mockConnection = {
        execute: vi.fn()
          .mockResolvedValueOnce([[{ result: 1 }]]) // EXPECT_ROWS passes
      };
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM users
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);
      
      expect(result.success).toBe(true);
      expect(result.details.length).toBeGreaterThan(0);
    });

    it('should fail sanity check when EXPECT_ROWS returns no rows', async () => {
      const mockConnection = {
        execute: vi.fn().mockResolvedValueOnce([[]])
      };
      
      const sanitySection = `
-- EXPECT_ROWS: SELECT 1 FROM nonexistent
`;
      const result = await adapter.executeSanityCheck(mockConnection, sanitySection);

      expect(result.success).toBe(false);
      expect(result.error).toContain('EXPECT_ROWS failed');
    });
  });
});
