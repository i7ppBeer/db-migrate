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
      expect(result.error).toContain('Sanity check failed');
    });
  });

  describe('extractSanitySection — implicit close (no -- -sanity)', () => {
    it('should end at next -- +migrate Up', () => {
      const sql = `
-- +sanity PreCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='users';

-- +migrate Up
CREATE TABLE users (id INT);

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.extractSanitySection(sql, 'PreCheck');
      expect(result).toContain("SELECT 1 FROM information_schema.TABLES");
      expect(result).not.toContain('CREATE TABLE');
    });

    it('should end at next -- +sanity PostCheck', () => {
      const sql = `
-- +sanity PreCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='users';

-- +sanity PostCheck
SELECT 1 FROM information_schema.COLUMNS WHERE COLUMN_NAME='email';

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.extractSanitySection(sql, 'PreCheck');
      expect(result).toContain("TABLE_NAME='users'");
      expect(result).not.toContain("COLUMN_NAME='email'");
    });

    it('should work when sanity block is at end of file (no trailing marker)', () => {
      const sql = `
-- +migrate Up
CREATE TABLE users (id INT);

-- +sanity PostCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='users';
`;
      const result = adapter.extractSanitySection(sql, 'PostCheck');
      expect(result).toContain("TABLE_NAME='users'");
    });

    it('should prefer explicit -- -sanity close over implicit', () => {
      const sql = `
-- +sanity PreCheck
SELECT 1 FROM t1;
-- -sanity PreCheck

-- +migrate Up
CREATE TABLE t1 (id INT);
`;
      const result = adapter.extractSanitySection(sql, 'PreCheck');
      expect(result).toBe('SELECT 1 FROM t1;');
    });
  });

  describe('executeSanityCheck — raw SQL format', () => {
    let mockConnection;

    beforeEach(() => {
      mockConnection = {
        execute: vi.fn()
      };
    });

    it('should execute bare SQL as EXPECT_ROWS (pass)', async () => {
      mockConnection.execute.mockResolvedValue([[{ r: 1 }]]);
      const section = `SELECT 1 FROM users;`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
      expect(mockConnection.execute).toHaveBeenCalledWith('SELECT 1 FROM users');
    });

    it('should fail bare SQL when 0 rows returned', async () => {
      mockConnection.execute.mockResolvedValue([[]]);
      const section = `SELECT 1 FROM users;`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Sanity check failed');
    });

    it('should split multiple statements by semicolon', async () => {
      mockConnection.execute
        .mockResolvedValueOnce([[{ r: 1 }]])
        .mockResolvedValueOnce([[{ r: 1 }]]);
      const section = `SELECT 1 FROM t1;\nSELECT 1 FROM t2;`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
      expect(mockConnection.execute).toHaveBeenCalledTimes(2);
    });

    it('should support multi-line SQL split by semicolon', async () => {
      mockConnection.execute.mockResolvedValue([[{ r: 1 }]]);
      const section = `
SELECT 1 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA='analytics'
    AND TABLE_NAME='events'
    AND COLUMN_NAME='platform';
`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
      expect(mockConnection.execute).toHaveBeenCalledTimes(1);
      const calledSQL = mockConnection.execute.mock.calls[0][0];
      expect(calledSQL).toContain("COLUMN_NAME='platform'");
    });

    it('should handle NOT EXISTS wrapper (zero rows = fail)', async () => {
      // NOT EXISTS returns 1 row when subquery has 0 rows → pass
      mockConnection.execute.mockResolvedValue([[{ r: 1 }]]);
      const section = `
SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA='analytics' AND COLUMN_NAME='platform'
);
`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
    });

    it('should mix legacy directives and raw SQL', async () => {
      mockConnection.execute
        .mockResolvedValueOnce([[{ r: 1 }]])  // EXPECT_ROWS
        .mockResolvedValueOnce([[]]);           // EXPECT_NO_ROWS
      // Legacy directives processed first (line by line), then raw SQL buffer (empty here)
      const section = `
-- EXPECT_ROWS: SELECT 1 FROM t1
-- EXPECT_NO_ROWS: SELECT 1 FROM t2
`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
      expect(result.details).toHaveLength(2);
    });

    it('should skip comment lines in raw SQL', async () => {
      mockConnection.execute.mockResolvedValue([[{ r: 1 }]]);
      const section = `
-- Check that the table exists
SELECT 1 FROM t1;
`;
      const result = await adapter.executeSanityCheck(mockConnection, section);
      expect(result.success).toBe(true);
      expect(mockConnection.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('stripSanityBlocks', () => {
    it('should strip explicit close blocks', () => {
      const content = `
-- +sanity PreCheck
SELECT 1 FROM t;
-- -sanity PreCheck

-- +migrate Up
CREATE TABLE t (id INT);
`;
      const result = adapter.stripSanityBlocks(content);
      expect(result).not.toContain('SELECT 1 FROM t;');
      expect(result).toContain('CREATE TABLE t (id INT)');
    });

    it('should strip END_CHECK close blocks', () => {
      const content = `
-- +sanity PreCheck
-- EXPECT_ROWS: SELECT 1 FROM t
-- END_CHECK

-- +migrate Up
CREATE TABLE t (id INT);
`;
      const result = adapter.stripSanityBlocks(content);
      expect(result).not.toContain('EXPECT_ROWS');
      expect(result).toContain('CREATE TABLE t (id INT)');
    });

    it('should strip implicit close blocks (ends at -- +migrate)', () => {
      const content = `
-- +sanity PreCheck
SELECT 1 FROM t;

-- +migrate Up
CREATE TABLE t (id INT);
`;
      const result = adapter.stripSanityBlocks(content);
      expect(result).not.toContain('SELECT 1 FROM t;');
      expect(result).toContain('CREATE TABLE t (id INT)');
    });
  });

  describe('extractSection — sanity block stripping', () => {
    it('should not include PreCheck raw SQL in Up section', () => {
      const content = `
-- +sanity PreCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='users';

-- +migrate Up
ALTER TABLE users ADD COLUMN email VARCHAR(255);

-- +sanity PostCheck
SELECT 1 FROM information_schema.COLUMNS WHERE COLUMN_NAME='email';

-- +migrate Down
ALTER TABLE users DROP COLUMN email;
`;
      const up = adapter.extractSection(content, 'Up');
      expect(up).toContain('ALTER TABLE users ADD COLUMN email');
      expect(up).not.toContain("TABLE_NAME='users'");
      expect(up).not.toContain("COLUMN_NAME='email'");
    });

    it('should not include PostCheck raw SQL in Down section', () => {
      const content = `
-- +migrate Up
ALTER TABLE users ADD COLUMN email VARCHAR(255);

-- +sanity PostCheck
SELECT 1 FROM information_schema.COLUMNS WHERE COLUMN_NAME='email';

-- +migrate Down
ALTER TABLE users DROP COLUMN email;
`;
      const down = adapter.extractSection(content, 'Down');
      expect(down).toContain('ALTER TABLE users DROP COLUMN email');
      expect(down).not.toContain("COLUMN_NAME='email'");
    });
  });

  describe('validateSQLSyntax — sanity block SQL check', () => {
    it('should catch syntax error in PostCheck raw SQL (e.g. WHER instead of WHERE)', () => {
      const sql = `
-- +sanity PreCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='events';

-- +migrate Up
CREATE TABLE events (id INT);

-- +sanity PostCheck
SELECT 1 FROM information_schema.TABLES WHER TABLE_NAME='events';

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors.some(e => e.code === 'SANITY_SQL_SYNTAX_ERROR')).toBe(true);
      expect(result.errors.some(e => e.message.includes('PostCheck'))).toBe(true);
    });

    it('should catch syntax error in PreCheck raw SQL', () => {
      const sql = `
-- +sanity PreCheck
SELEC 1 FROM information_schema.TABLES WHERE TABLE_NAME='events';

-- +migrate Up
CREATE TABLE events (id INT);

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors.some(e => e.code === 'SANITY_SQL_SYNTAX_ERROR')).toBe(true);
      expect(result.errors.some(e => e.message.includes('PreCheck'))).toBe(true);
    });

    it('should catch syntax error in legacy EXPECT_ROWS directive', () => {
      const sql = `
-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FORM information_schema.TABLES WHERE TABLE_NAME='events'

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors.some(e => e.code === 'SANITY_SQL_SYNTAX_ERROR')).toBe(true);
    });

    it('should pass when sanity SQL is valid', () => {
      const sql = `
-- +sanity PreCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='events';

-- +migrate Up
CREATE TABLE events (id INT);

-- +sanity PostCheck
SELECT 1 FROM information_schema.TABLES WHERE TABLE_NAME='events';

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors.filter(e => e.code === 'SANITY_SQL_SYNTAX_ERROR')).toHaveLength(0);
    });

    it('should not report sanity errors when @skip-syntax-check is set', () => {
      const sql = `
-- @skip-syntax-check: true
-- +sanity PostCheck
SELECT 1 FROM information_schema.TABLES WHER TABLE_NAME='events';

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some(w => w.type === 'syntax-check-skipped')).toBe(true);
    });

    it('should catch syntax error in Down section (e.g. ALER TABLE)', () => {
      const sql = `
-- +migrate Up
CREATE TABLE events (id INT);

-- +migrate Down
ALER TABLE events DROP COLUMN id;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors.some(e => e.code === 'SQL_SYNTAX_ERROR_DOWN')).toBe(true);
      expect(result.errors.some(e => e.message.includes('Down'))).toBe(true);
    });

    it('should pass when both Up and Down are valid', () => {
      const sql = `
-- +migrate Up
CREATE TABLE events (id INT);

-- +migrate Down
DROP TABLE events;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      expect(result.errors).toHaveLength(0);
    });

    it('should catch errors in all four sections simultaneously', () => {
      const sql = `
-- +sanity PreCheck
SELEC 1 FROM t;

-- +migrate Up
CREAT TABLE t (id INT);

-- +sanity PostCheck
SELEC 1 FROM t;

-- +migrate Down
DRO TABLE t;
`;
      const result = adapter.validateSQLSyntax(sql, 'test.sql');
      // Up error + Down error + PreCheck error + PostCheck error = 4
      expect(result.errors.length).toBe(4);
      expect(result.errors.some(e => e.code === 'SQL_SYNTAX_ERROR')).toBe(true);
      expect(result.errors.some(e => e.code === 'SQL_SYNTAX_ERROR_DOWN')).toBe(true);
      expect(result.errors.some(e => e.message.includes('PreCheck'))).toBe(true);
      expect(result.errors.some(e => e.message.includes('PostCheck'))).toBe(true);
    });
  });

  describe('validateContent() — mode-aware validation', () => {
    describe('DDL mode (versioned, default)', () => {
      it('should forbid CREATE USER in DDL migration', () => {
        const sql = `
-- +migrate Up
CREATE USER 'app'@'%' IDENTIFIED BY 'secret';
-- +migrate Down
DROP USER IF EXISTS 'app'@'%';
`;
        const result = adapter.validateContent(sql, 'V001__add_user.sql');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(true);
      });

      it('should forbid GRANT in DDL migration', () => {
        const sql = `
-- +migrate Up
GRANT SELECT ON mydb.* TO 'app'@'%';
-- +migrate Down
REVOKE SELECT ON mydb.* FROM 'app'@'%';
`;
        const result = adapter.validateContent(sql, 'V001__grant.sql');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(true);
      });

      it('should emit missing-DOWN warning', () => {
        const sql = `-- +migrate Up\nCREATE TABLE foo (id INT);\n`;
        const result = adapter.validateContent(sql, 'V001__create.sql');
        expect(result.warnings.some(w => w.type === 'missing-down')).toBe(true);
      });
    });

    describe('DCL mode (repeatable)', () => {
      let dclAdapter;
      beforeEach(() => {
        dclAdapter = new MariaDBAdapter({ ...mockConfig, mode: 'repeatable' });
      });

      it('should NOT forbid CREATE USER in DCL migration', () => {
        const sql = `DROP USER IF EXISTS 'app'@'%';\nCREATE USER 'app'@'%' IDENTIFIED BY 'secret';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(false);
      });

      it('should forbid DROP USER in DCL migration (dclHighRisk)', () => {
        const sql = `DROP USER IF EXISTS 'app'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(true);
      });

      it('should allow DROP USER with -- @allow-forbidden: true annotation', () => {
        const sql = `-- @allow-forbidden: true\nDROP USER IF EXISTS 'app'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(false);
      });

      it('should allow DROP USER with specific -- @allow: DROP_USER annotation', () => {
        const sql = `-- @allow: DROP_USER\nDROP USER IF EXISTS 'app'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(false);
      });

      it('should forbid ALTER USER in DCL migration (dclHighRisk)', () => {
        const sql = `ALTER USER 'app'@'%' IDENTIFIED BY 'newpass';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'ALTER_USER')).toBe(true);
      });

      it('should allow ALTER USER with -- @allow-forbidden: true annotation', () => {
        const sql = `-- @allow-forbidden: true\nALTER USER 'app'@'%' IDENTIFIED BY 'newpass';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'ALTER_USER')).toBe(false);
      });

      it('should forbid SET PASSWORD FOR in DCL migration (dclHighRisk)', () => {
        const sql = `SET PASSWORD FOR 'app'@'%' = PASSWORD('newpass');\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'SET_PASSWORD')).toBe(true);
      });

      it('should allow SET PASSWORD FOR with -- @allow-forbidden: true annotation', () => {
        const sql = `-- @allow-forbidden: true\nSET PASSWORD FOR 'app'@'%' = PASSWORD('newpass');\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'SET_PASSWORD')).toBe(false);
      });

      it('should forbid CREATE INDEX in DCL migration (expanded dclReverse)', () => {
        const sql = `CREATE INDEX idx_email ON users(email);\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_INDEX_IN_DCL')).toBe(true);
      });

      it('should NOT allow CREATE INDEX bypass with annotation (dclReverse is absolute)', () => {
        const sql = `-- @allow-forbidden: true\nCREATE INDEX idx_email ON users(email);\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_INDEX_IN_DCL')).toBe(true);
      });

      it('should forbid DROP INDEX in DCL migration (expanded dclReverse)', () => {
        const sql = `DROP INDEX idx_email ON users;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_INDEX_IN_DCL')).toBe(true);
      });

      it('should forbid CREATE VIEW in DCL migration (expanded dclReverse)', () => {
        const sql = `CREATE VIEW v_users AS SELECT id FROM users;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_VIEW_IN_DCL')).toBe(true);
      });

      it('should forbid DROP VIEW in DCL migration (expanded dclReverse)', () => {
        const sql = `DROP VIEW v_users;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_VIEW_IN_DCL')).toBe(true);
      });

      it('should forbid CREATE PROCEDURE in DCL migration (expanded dclReverse)', () => {
        const sql = `CREATE PROCEDURE my_proc() BEGIN SELECT 1; END;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_ROUTINE_IN_DCL')).toBe(true);
      });

      it('should forbid DROP PROCEDURE in DCL migration (expanded dclReverse)', () => {
        const sql = `DROP PROCEDURE IF EXISTS my_proc;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_ROUTINE_IN_DCL')).toBe(true);
      });

      it('should forbid CREATE TRIGGER in DCL migration (expanded dclReverse)', () => {
        const sql = `CREATE TRIGGER trg_before BEFORE INSERT ON users FOR EACH ROW BEGIN END;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_TRIGGER_IN_DCL')).toBe(true);
      });

      it('should forbid DROP TRIGGER in DCL migration (expanded dclReverse)', () => {
        const sql = `DROP TRIGGER IF EXISTS trg_before;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'DROP_TRIGGER_IN_DCL')).toBe(true);
      });

      it('should forbid RENAME TABLE in DCL migration (expanded dclReverse)', () => {
        const sql = `RENAME TABLE old_users TO users;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'RENAME_TABLE_IN_DCL')).toBe(true);
      });

      it('should pass a full idiomatic R__ file: DROP IF EXISTS + CREATE + GRANT with annotation at top', () => {
        const sql = [
          `-- @allow-forbidden: true`,
          `DROP USER IF EXISTS 'app'@'%';`,
          `CREATE USER 'app'@'%' IDENTIFIED BY 'secret';`,
          `GRANT SELECT ON mydb.* TO 'app'@'%';`,
          `FLUSH PRIVILEGES;`
        ].join('\n');
        const result = dclAdapter.validateContent(sql, 'R__001_drop_create.sql');
        // DROP USER present but annotation at top covers it
        expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(false);
      });

      it('should NOT forbid GRANT in DCL migration', () => {
        const sql = `GRANT SELECT ON mydb.* TO 'app'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(false);
      });

      it('should NOT forbid FLUSH PRIVILEGES in DCL migration', () => {
        const sql = `FLUSH PRIVILEGES;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.forbiddenOps.some(op => op.code === 'FLUSH_PRIVILEGES')).toBe(false);
      });

      it('should forbid CREATE TABLE in DCL migration (dclReverse)', () => {
        const sql = `CREATE TABLE users (id INT);\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_TABLE_IN_DCL')).toBe(true);
      });

      it('should forbid ALTER TABLE in DCL migration (dclReverse)', () => {
        const sql = `ALTER TABLE users ADD COLUMN email VARCHAR(255);\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'ALTER_TABLE_IN_DCL')).toBe(true);
      });

      it('should NOT emit missing-DOWN warning for R__ file', () => {
        const sql = `DROP USER IF EXISTS 'app'@'%';\nCREATE USER 'app'@'%' IDENTIFIED BY 'secret';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_app_user.sql');
        expect(result.warnings.some(w => w.type === 'missing-down')).toBe(false);
      });

      it('should still block dangerous ops (TRUNCATE valid in both modes)', () => {
        const sql = `TRUNCATE TABLE audit_log;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_cleanup.sql');
        expect(result.dangerousOps.some(op => op.code === 'TRUNCATE_TABLE')).toBe(true);
      });

      it('should still block system-level forbidden ops (SET GLOBAL valid in both modes)', () => {
        const sql = `SET GLOBAL max_connections = 500;\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
        expect(result.forbiddenOps.some(op => op.code === 'SET_GLOBAL')).toBe(true);
      });
    });
  });
});
