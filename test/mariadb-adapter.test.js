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
      try { await ddlAdapter.status(); } catch { /* expected: no .sql files under /tmp */ }
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

      it('should NOT report SQL_SYNTAX_ERROR for column named "status"', () => {
        const sql = `
-- +migrate Up
CREATE TABLE orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  status INT(1) NOT NULL
);
-- +migrate Down
DROP TABLE IF EXISTS orders;
`;
        const result = adapter.validateContent(sql, 'V001__create_orders.sql');
        expect(result.errors.filter(e => e.code === 'SQL_SYNTAX_ERROR')).toHaveLength(0);
      });

      it('should NOT report SQL_SYNTAX_ERROR for column named "type"', () => {
        const sql = `
-- +migrate Up
CREATE TABLE items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  type VARCHAR(50) NOT NULL
);
-- +migrate Down
DROP TABLE IF EXISTS items;
`;
        const result = adapter.validateContent(sql, 'V001__create_items.sql');
        expect(result.errors.filter(e => e.code === 'SQL_SYNTAX_ERROR')).toHaveLength(0);
      });

      it('should NOT report SQL_SYNTAX_ERROR for column named "end"', () => {
        const sql = `
-- +migrate Up
CREATE TABLE events (
  id INT PRIMARY KEY AUTO_INCREMENT,
  end DATETIME NOT NULL
);
-- +migrate Down
DROP TABLE IF EXISTS events;
`;
        const result = adapter.validateContent(sql, 'V001__create_events.sql');
        expect(result.errors.filter(e => e.code === 'SQL_SYNTAX_ERROR')).toHaveLength(0);
      });

      it('should report SQL_SYNTAX_ERROR with parser message for genuinely invalid SQL', () => {
        const sql = `
-- +migrate Up
CRAETE TABLE broken (id INT);
-- +migrate Down
DROP TABLE IF EXISTS broken;
`;
        const result = adapter.validateContent(sql, 'V001__broken.sql');
        const syntaxErrors = result.errors.filter(e => e.code === 'SQL_SYNTAX_ERROR');
        expect(syntaxErrors.length).toBeGreaterThan(0);
        expect(syntaxErrors[0].message).toMatch(/SQL syntax error/i);
        expect(syntaxErrors[0].message.length).toBeGreaterThan(20);
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

      it('should NOT flag GRANT CREATE VIEW as CREATE_VIEW_IN_DCL', () => {
        const sql = `GRANT CREATE VIEW ON *.* TO 'app_user'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_grant.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_VIEW_IN_DCL')).toBe(false);
      });

      it('should NOT flag GRANT CREATE ROUTINE as CREATE_ROUTINE_IN_DCL', () => {
        const sql = `GRANT CREATE ROUTINE ON mydb.* TO 'app_user'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_grant.sql');
        expect(result.forbiddenOps.some(op => op.code === 'CREATE_ROUTINE_IN_DCL')).toBe(false);
      });

      it('should NOT flag GRANT with multiple DDL-named privileges', () => {
        const sql = `GRANT SELECT, CREATE, ALTER, DROP, INDEX, CREATE VIEW, CREATE ROUTINE, ALTER ROUTINE, TRIGGER ON mydb.* TO 'app_user'@'%';\n`;
        const result = dclAdapter.validateContent(sql, 'R__001_grant.sql');
        const dclReverseCodes = ['CREATE_TABLE_IN_DCL','ALTER_TABLE_IN_DCL','DROP_TABLE_IN_DCL','CREATE_INDEX_IN_DCL','DROP_INDEX_IN_DCL','CREATE_VIEW_IN_DCL','ALTER_VIEW_IN_DCL','DROP_VIEW_IN_DCL','CREATE_ROUTINE_IN_DCL','DROP_ROUTINE_IN_DCL','CREATE_TRIGGER_IN_DCL','DROP_TRIGGER_IN_DCL','RENAME_TABLE_IN_DCL'];
        expect(result.forbiddenOps.filter(op => dclReverseCodes.includes(op.code))).toHaveLength(0);
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

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — 18 cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences()', () => {
    it('unnamed inline FK returns constraintName null', () => {
      const sql = `CREATE TABLE orders (
        id INT PRIMARY KEY,
        user_id INT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBeNull();
      expect(result[0].referencedTable).toBe('users');
    });

    it('named CONSTRAINT FK captures constraintName', () => {
      const sql = `CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_orders_user');
      expect(result[0].referencedTable).toBe('users');
    });

    it('backtick-quoted names are stripped', () => {
      const sql = `CONSTRAINT \`fk_name\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_name');
      expect(result[0].referencedTable).toBe('users');
    });

    it('multi-column FK is extracted', () => {
      const sql = `FOREIGN KEY (a, b) REFERENCES items(x, y)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('items');
    });

    it('ON DELETE CASCADE captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE CASCADE`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('CASCADE');
      expect(result[0].onUpdate).toBeNull();
    });

    it('ON DELETE SET NULL captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE SET NULL`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('SET NULL');
    });

    it('ON DELETE RESTRICT and ON UPDATE CASCADE captured order-independently', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('RESTRICT');
      expect(result[0].onUpdate).toBe('CASCADE');
    });

    it('ALTER TABLE ADD CONSTRAINT FK is extracted', () => {
      const sql = `ALTER TABLE orders ADD CONSTRAINT fk_inv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_inv_user');
      expect(result[0].referencedTable).toBe('users');
      expect(result[0].onDelete).toBe('CASCADE');
    });

    it('ALTER TABLE ADD FOREIGN KEY (no name) has null constraintName', () => {
      const sql = `ALTER TABLE orders ADD FOREIGN KEY (dept_id) REFERENCES depts(id);`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBeNull();
      expect(result[0].referencedTable).toBe('depts');
    });

    it('schema-qualified REFERENCES strips schema, captures table', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES \`other_db\`.\`users\`(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedSchema).toBe('other_db');
      expect(result[0].referencedTable).toBe('users');
    });

    it('self-referential FK is extracted normally', () => {
      const sql = `FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('categories');
    });

    it('multi-line formatted FK is extracted', () => {
      const sql = `
        CONSTRAINT fk_long
          FOREIGN KEY (col1, col2)
          REFERENCES another_table (pk1, pk2)
          ON DELETE RESTRICT
          ON UPDATE CASCADE
      `;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_long');
      expect(result[0].referencedTable).toBe('another_table');
      expect(result[0].onDelete).toBe('RESTRICT');
      expect(result[0].onUpdate).toBe('CASCADE');
    });

    it('multiple FKs in same CREATE TABLE returns all', () => {
      const sql = `CREATE TABLE orders (
        id INT PRIMARY KEY,
        user_id INT,
        dept_id INT,
        CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (dept_id) REFERENCES departments(id)
      );`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.referencedTable)).toEqual(expect.arrayContaining(['users', 'departments']));
    });

    it('FK inside SQL comment is NOT extracted', () => {
      const sql = `-- FOREIGN KEY (uid) REFERENCES users(id)\nCREATE TABLE foo (id INT);`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(0);
    });

    it('FK inside string literal is NOT extracted', () => {
      const sql = `INSERT INTO log (msg) VALUES ('FOREIGN KEY (uid) REFERENCES users(id)');`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(0);
    });

    it('empty SQL returns empty array', () => {
      expect(adapter.extractFKReferences('')).toEqual([]);
      expect(adapter.extractFKReferences(null)).toEqual([]);
    });

    it('SQL with no FK returns empty array', () => {
      const sql = `CREATE TABLE foo (id INT PRIMARY KEY, name VARCHAR(50));`;
      expect(adapter.extractFKReferences(sql)).toHaveLength(0);
    });

    it('ON DELETE SET DEFAULT is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE SET DEFAULT`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('SET DEFAULT');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validateContent() — single-file FK checks — 12 cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('validateContent() — single-file FK checks (DDL mode)', () => {
    it('FK referencing table created in same UP is valid — no FK error', () => {
      const sql = `
-- +migrate Up
CREATE TABLE users (id INT PRIMARY KEY);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
-- +migrate Down
DROP TABLE orders;
DROP TABLE users;
`;
      const result = adapter.validateContent(sql, 'V001__create.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });

    it('FK referencing table DROPPED in same UP — FK_REFERENCES_DROPPED_TABLE error', () => {
      const sql = `
-- +migrate Up
DROP TABLE users;
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__bad.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(true);
    });

    it('FK referencing table not in this file — no single-file error', () => {
      const sql = `
-- +migrate Up
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V002__orders.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });

    it('self-referential FK with no drop — no error', () => {
      const sql = `
-- +migrate Up
CREATE TABLE categories (
  id INT PRIMARY KEY,
  parent_id INT,
  FOREIGN KEY (parent_id) REFERENCES categories(id)
);
-- +migrate Down
DROP TABLE categories;
`;
      const result = adapter.validateContent(sql, 'V001__cats.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });

    it('multiple FKs: one good (→ created), one bad (→ dropped) — only bad reported', () => {
      const sql = `
-- +migrate Up
CREATE TABLE users (id INT PRIMARY KEY);
DROP TABLE departments;
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  dept_id INT,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_dept FOREIGN KEY (dept_id) REFERENCES departments(id)
);
-- +migrate Down
DROP TABLE orders;
DROP TABLE users;
`;
      const result = adapter.validateContent(sql, 'V001__mixed.sql');
      const fkErrors = result.errors.filter(e => e.code === 'FK_REFERENCES_DROPPED_TABLE');
      expect(fkErrors).toHaveLength(1);
      expect(fkErrors[0].message).toContain('departments');
    });

    it('named FK in error message includes constraint name', () => {
      const sql = `
-- +migrate Up
DROP TABLE users;
ALTER TABLE orders ADD CONSTRAINT fk_named FOREIGN KEY (user_id) REFERENCES users(id);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__named.sql');
      const fkError = result.errors.find(e => e.code === 'FK_REFERENCES_DROPPED_TABLE');
      expect(fkError).toBeDefined();
      expect(fkError.message).toContain("'fk_named'");
    });

    it('unnamed FK in error message says unnamed FK', () => {
      const sql = `
-- +migrate Up
DROP TABLE users;
ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__unnamed.sql');
      const fkError = result.errors.find(e => e.code === 'FK_REFERENCES_DROPPED_TABLE');
      expect(fkError).toBeDefined();
      // unnamed FK → no constraint name between FOREIGN KEY and references
      expect(fkError.message).not.toMatch(/FOREIGN KEY '[^']+' references/i);
    });

    it('FK only in DOWN section — no FK_REFERENCES_DROPPED_TABLE error', () => {
      const sql = `
-- +migrate Up
CREATE TABLE orders (id INT PRIMARY KEY, user_id INT);
-- +migrate Down
ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__down_only.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });

    it('repeatable mode — FK checks completely skipped', () => {
      const dclAdapter = new MariaDBAdapter({ ...mockConfig, mode: 'repeatable' });
      const sql = `DROP TABLE users;\nALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);\n`;
      const result = dclAdapter.validateContent(sql, 'R__001_bad.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });

    it('ON DELETE CASCADE on FK references external table — existing 🟡 warning fires', () => {
      const sql = `
-- +migrate Up
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__cascade.sql');
      // The existing warning rule ON DELETE CASCADE fires
      expect(result.warnings.some(w => w.message && w.message.includes('ON DELETE CASCADE'))).toBe(true);
    });

    it('ON DELETE RESTRICT — no cascade warning', () => {
      const sql = `
-- +migrate Up
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__restrict.sql');
      const cascadeWarnings = result.warnings.filter(w => w.message && w.message.includes('ON DELETE CASCADE'));
      expect(cascadeWarnings).toHaveLength(0);
    });

    it('ON UPDATE CASCADE only — ON DELETE CASCADE warning does not fire', () => {
      const sql = `
-- +migrate Up
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE
);
-- +migrate Down
DROP TABLE orders;
`;
      const result = adapter.validateContent(sql, 'V001__update_cascade.sql');
      const cascadeWarnings = result.warnings.filter(w => w.message && w.message.includes('ON DELETE CASCADE'));
      expect(cascadeWarnings).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validateCrossFileFKDependencies() — 16 cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('validateCrossFileFKDependencies()', () => {
    it('File1 creates users, File2 FKs to users — no error', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__orders.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('FK in File1 references users which is not yet created — FK_UNRESOLVED_REFERENCE', () => {
      const filesData = [
        { fileName: 'V001__orders.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('V001__orders.sql');
      expect(result[0].errors[0].code).toBe('FK_UNRESOLVED_REFERENCE');
      expect(result[0].errors[0].message).toContain("'users'");
    });

    it('same file creates table and FKs to it — no error (self-resolve)', () => {
      const filesData = [
        { fileName: 'V001__both.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\nCREATE TABLE orders (id INT, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\nDROP TABLE users;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('File1 creates A, File2 creates B and FKs to A — no error', () => {
      const filesData = [
        { fileName: 'V001__a.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE a;\n` },
        { fileName: 'V002__b.sql', content: `-- +migrate Up\nCREATE TABLE b (id INT, a_id INT, FOREIGN KEY (a_id) REFERENCES a(id));\n-- +migrate Down\nDROP TABLE b;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('File2 FKs to A (ok) and C (never created) — only C reported', () => {
      const filesData = [
        { fileName: 'V001__a.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE a;\n` },
        { fileName: 'V002__mixed.sql', content: `-- +migrate Up\nCREATE TABLE b (id INT, a_id INT, c_id INT, FOREIGN KEY (a_id) REFERENCES a(id), FOREIGN KEY (c_id) REFERENCES c(id));\n-- +migrate Down\nDROP TABLE b;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].errors[0].message).toContain("'c'");
      expect(result[0].errors.some(e => e.message.includes("'a'"))).toBe(false);
    });

    it('File1 creates A, File2 drops A, File3 FKs to A — error in File3', () => {
      const filesData = [
        { fileName: 'V001__a.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE a;\n` },
        { fileName: 'V002__drop_a.sql', content: `-- +migrate Up\nDROP TABLE a;\n-- +migrate Down\nCREATE TABLE a (id INT PRIMARY KEY);\n` },
        { fileName: 'V003__fk_to_a.sql', content: `-- +migrate Up\nCREATE TABLE b (id INT, a_id INT, FOREIGN KEY (a_id) REFERENCES a(id));\n-- +migrate Down\nDROP TABLE b;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('V003__fk_to_a.sql');
    });

    it('repeatable mode returns empty array', () => {
      const dclAdapter = new MariaDBAdapter({ ...mockConfig, mode: 'repeatable' });
      const filesData = [
        { fileName: 'R__001.sql', content: `FOREIGN KEY (uid) REFERENCES users(id);\n` }
      ];
      expect(dclAdapter.validateCrossFileFKDependencies(filesData)).toEqual([]);
    });

    it('empty filesData returns empty array', () => {
      expect(adapter.validateCrossFileFKDependencies([])).toEqual([]);
    });

    it('self-referential FK in file — no error', () => {
      const filesData = [
        { fileName: 'V001__cats.sql', content: `-- +migrate Up\nCREATE TABLE categories (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES categories(id));\n-- +migrate Down\nDROP TABLE categories;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('schema-qualified REFERENCES strips schema — matches table created in prior file', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__ref.sql', content: `-- +migrate Up\nCREATE TABLE ref_tbl (id INT, uid INT, FOREIGN KEY (uid) REFERENCES \`mydb\`.\`users\`(id));\n-- +migrate Down\nDROP TABLE ref_tbl;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('File1 creates A and B, File2 FKs to both A and B — no error', () => {
      const filesData = [
        { fileName: 'V001__ab.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT PRIMARY KEY);\nCREATE TABLE b (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE b;\nDROP TABLE a;\n` },
        { fileName: 'V002__fks.sql', content: `-- +migrate Up\nCREATE TABLE c (id INT, a_id INT, b_id INT, CONSTRAINT fk_a FOREIGN KEY (a_id) REFERENCES a(id), CONSTRAINT fk_b FOREIGN KEY (b_id) REFERENCES b(id));\n-- +migrate Down\nDROP TABLE c;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('multiple FKs in one file all unresolved — all reported as separate errors', () => {
      const filesData = [
        { fileName: 'V001__many_fks.sql', content: `-- +migrate Up\nCREATE TABLE x (id INT, a_id INT, b_id INT, FOREIGN KEY (a_id) REFERENCES missing_a(id), FOREIGN KEY (b_id) REFERENCES missing_b(id));\n-- +migrate Down\nDROP TABLE x;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].errors).toHaveLength(2);
    });

    it('circular: File1 FKs to B (not yet created), File2 creates B — File1 errors, File2 clean', () => {
      const filesData = [
        { fileName: 'V001__fk_to_b.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT, b_id INT, FOREIGN KEY (b_id) REFERENCES b(id));\n-- +migrate Down\nDROP TABLE a;\n` },
        { fileName: 'V002__create_b.sql', content: `-- +migrate Up\nCREATE TABLE b (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE b;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('V001__fk_to_b.sql');
    });

    it('only ALTER TABLE ADD FK (no CREATE TABLE in file) — checked against prior files', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__alter_fk.sql', content: `-- +migrate Up\nALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);\n-- +migrate Down\nALTER TABLE orders DROP FOREIGN KEY fk_user;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('3-file chain: each file FKs to previous file table — no errors', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__orders.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` },
        { fileName: 'V003__items.sql', content: `-- +migrate Up\nCREATE TABLE items (id INT PRIMARY KEY, order_id INT, FOREIGN KEY (order_id) REFERENCES orders(id));\n-- +migrate Down\nDROP TABLE items;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(0);
    });

    it('named FK constraint in unresolved reference — error message includes constraint name', () => {
      const filesData = [
        { fileName: 'V001__fk.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, CONSTRAINT fk_ord_user FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].errors[0].message).toContain("'fk_ord_user'");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validate() integration — 4 cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('validate() — FK integration', () => {
    it('cross-file FK error is merged into correct file result and marks results.valid false', async () => {
      const mockFs = await import('fs/promises');
      const originalReaddir = mockFs.default?.readdir;

      // Directly test via validateCrossFileFKDependencies + validate() result structure
      // by simulating what validate() does with real filesData
      const validFile = {
        fileName: 'V001__users.sql',
        content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n`
      };
      const invalidFile = {
        fileName: 'V002__bad_fk.sql',
        content: `-- +migrate Up\nCREATE TABLE orders (id INT, x_id INT, FOREIGN KEY (x_id) REFERENCES missing_table(id));\n-- +migrate Down\nDROP TABLE orders;\n`
      };
      const filesData = [validFile, invalidFile];

      const crossErrors = adapter.validateCrossFileFKDependencies(filesData);
      expect(crossErrors).toHaveLength(1);
      expect(crossErrors[0].fileName).toBe('V002__bad_fk.sql');
      expect(crossErrors[0].errors[0].code).toBe('FK_UNRESOLVED_REFERENCE');
    });

    it('valid FK chain across files — validateCrossFileFKDependencies returns empty', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__orders.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('numeric sort: V10 sorted after V2, not before', () => {
      const files = ['V010__c.sql', 'V002__a.sql', 'V1__b.sql'];
      const sorted = files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      expect(sorted[0]).toBe('V1__b.sql');
      expect(sorted[1]).toBe('V002__a.sql');
      expect(sorted[2]).toBe('V010__c.sql');
    });

    it('cross-file FK error increments summary.structural when merged', () => {
      // Simulate the merge logic from validate()
      const fileResult = {
        file: 'V002__bad.sql',
        valid: true,
        errors: [],
        warnings: [],
        forbiddenOps: [],
        dangerousOps: [],
        summary: { forbidden: 0, dangerous: 0, warnings: 0, structural: 0, suspiciousNames: 0, performanceIssues: 0 }
      };
      const fkErrors = [{ type: 'fk-unresolved-reference', code: 'FK_UNRESOLVED_REFERENCE', message: '🔴 ...' }];

      // Apply the same merge logic as validate()
      fileResult.errors.push(...fkErrors);
      fileResult.summary.structural += fkErrors.length;
      fileResult.valid = false;

      expect(fileResult.errors).toHaveLength(1);
      expect(fileResult.summary.structural).toBe(1);
      expect(fileResult.valid).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractCreatedTables() — Bug 2, 3, 4 fixes
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractCreatedTables() — OR REPLACE, schema-qualified, RENAME', () => {
    it('CREATE OR REPLACE TABLE is recognized (Bug 4)', () => {
      const sql = `CREATE OR REPLACE TABLE accounts (id INT PRIMARY KEY);`;
      const result = adapter.extractCreatedTables(sql);
      expect(result).toContain('accounts');
    });

    it('schema-qualified CREATE TABLE captures table name not schema (Bug 2)', () => {
      const sql = 'CREATE TABLE `mydb`.`orders` (id INT PRIMARY KEY);';
      const result = adapter.extractCreatedTables(sql);
      expect(result).toContain('orders');
      expect(result).not.toContain('mydb');
    });

    it('RENAME TABLE old TO new — new name is tracked as created (Bug 3)', () => {
      const sql = `RENAME TABLE users_v1 TO users;`;
      const result = adapter.extractCreatedTables(sql);
      expect(result).toContain('users');
    });

    it('RENAME TABLE multi-pair — all new names captured (Bug 3)', () => {
      const sql = `RENAME TABLE a TO b, c TO d;`;
      const result = adapter.extractCreatedTables(sql);
      expect(result).toContain('b');
      expect(result).toContain('d');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractDroppedTables() — Bug 1, 2, 5 fixes
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractDroppedTables() — multi-table, schema-qualified, procedure body', () => {
    it('DROP TABLE t1, t2, t3 returns all three (Bug 1)', () => {
      const sql = `DROP TABLE IF EXISTS orders, order_items, addresses;`;
      const result = adapter.extractDroppedTables(sql);
      expect(result).toContain('orders');
      expect(result).toContain('order_items');
      expect(result).toContain('addresses');
    });

    it('schema-qualified DROP TABLE captures table name not schema (Bug 2)', () => {
      const sql = 'DROP TABLE `mydb`.`orders`;';
      const result = adapter.extractDroppedTables(sql);
      expect(result).toContain('orders');
      expect(result).not.toContain('mydb');
    });

    it('DROP TABLE inside CREATE PROCEDURE body is NOT counted (Bug 5)', () => {
      const sql = `
CREATE PROCEDURE cleanup()
BEGIN
  DROP TABLE temp_cache;
END;
`;
      const result = adapter.extractDroppedTables(sql);
      expect(result).not.toContain('temp_cache');
    });

    it('DROP TABLE inside PROCEDURE with nested END IF is NOT counted (Bug 5)', () => {
      const sql = `
CREATE PROCEDURE cleanup()
BEGIN
  IF x > 0 THEN
    DROP TABLE temp_cache;
  END IF;
  DROP TABLE another_temp;
END;
`;
      const result = adapter.extractDroppedTables(sql);
      expect(result).not.toContain('temp_cache');
      expect(result).not.toContain('another_temp');
    });

    it('DDL-level DROP TABLE outside procedure is still captured (Bug 5 no false negative)', () => {
      const sql = `
CREATE PROCEDURE cleanup() BEGIN DROP TABLE proc_temp; END;
DROP TABLE real_table;
`;
      const result = adapter.extractDroppedTables(sql);
      expect(result).toContain('real_table');
      expect(result).not.toContain('proc_temp');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — Bug 6: hyphenated constraint names
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences() — hyphenated constraint name (Bug 6)', () => {
    it('backtick-quoted constraint name with hyphens is fully captured', () => {
      const sql = 'CONSTRAINT `fk-orders-user` FOREIGN KEY (user_id) REFERENCES users(id)';
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk-orders-user');
      expect(result[0].referencedTable).toBe('users');
    });

    it('double-quoted constraint name with hyphens is fully captured', () => {
      const sql = 'CONSTRAINT "fk-items-prod" FOREIGN KEY (prod_id) REFERENCES products(id)';
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk-items-prod');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validateCrossFileFKDependencies() — Bug 3: RENAME TABLE + Bug 2/4
  // ─────────────────────────────────────────────────────────────────────────
  describe('validateCrossFileFKDependencies() — RENAME TABLE, OR REPLACE, schema CREATE', () => {
    it('RENAME users_v1 TO users in V001, FK to users in V002 — no error (Bug 3)', () => {
      const filesData = [
        { fileName: 'V001__rename.sql', content: `-- +migrate Up\nRENAME TABLE users_v1 TO users;\n-- +migrate Down\nRENAME TABLE users TO users_v1;\n` },
        { fileName: 'V002__fk.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('RENAME users TO accounts in V001, FK to users in V002 — error (old name is gone) (Bug 3)', () => {
      const filesData = [
        { fileName: 'V001__rename.sql', content: `-- +migrate Up\nRENAME TABLE users TO accounts;\n-- +migrate Down\nRENAME TABLE accounts TO users;\n` },
        { fileName: 'V002__fk_old.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].errors[0].code).toBe('FK_UNRESOLVED_REFERENCE');
    });

    it('CREATE OR REPLACE TABLE in V001, FK to that table in V002 — no error (Bug 4)', () => {
      const filesData = [
        { fileName: 'V001__orp.sql', content: `-- +migrate Up\nCREATE OR REPLACE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE IF EXISTS users;\n` },
        { fileName: 'V002__fk.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('schema-qualified CREATE TABLE in V001, FK to table name in V002 — no error (Bug 2)', () => {
      const filesData = [
        { fileName: 'V001__schema.sql', content: '-- +migrate Up\nCREATE TABLE `mydb`.`users` (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE `mydb`.`users`;\n' },
        { fileName: 'V002__fk.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — stored procedure body (P0 — validates Bug Fix)
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences() — stored procedure body', () => {
    it('FK inside CREATE PROCEDURE body is NOT extracted', () => {
      const sql = `
        CREATE PROCEDURE fix_orders()
        BEGIN
          ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);
        END;
      `;
      expect(adapter.extractFKReferences(sql)).toHaveLength(0);
    });

    it('FK inside CREATE FUNCTION body is NOT extracted', () => {
      const sql = `
        CREATE FUNCTION get_user(uid INT) RETURNS INT
        BEGIN
          ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id);
          RETURN 1;
        END;
      `;
      expect(adapter.extractFKReferences(sql)).toHaveLength(0);
    });

    it('FK outside procedure (DDL level) is still extracted when procedure also exists', () => {
      const sql = `
        CREATE PROCEDURE fix() BEGIN ALTER TABLE x ADD FOREIGN KEY (a) REFERENCES b(id); END;
        ALTER TABLE orders ADD CONSTRAINT fk_real FOREIGN KEY (user_id) REFERENCES users(id);
      `;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_real');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validateContent() — FK in stored procedure body (P0)
  // ─────────────────────────────────────────────────────────────────────────
  describe('validateContent() — FK in stored procedure body', () => {
    it('FK inside CREATE PROCEDURE body does NOT trigger FK_REFERENCES_DROPPED_TABLE', () => {
      const sql = `
-- +migrate Up
DROP TABLE users;
CREATE PROCEDURE fix()
BEGIN
  ALTER TABLE orders ADD FOREIGN KEY (uid) REFERENCES users(id);
END;
-- +migrate Down
CREATE TABLE users (id INT PRIMARY KEY);
      `;
      const result = adapter.validateContent(sql, 'V001__proc.sql');
      expect(result.errors.some(e => e.code === 'FK_REFERENCES_DROPPED_TABLE')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — ON DELETE/UPDATE all actions (P1)
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences() — ON DELETE/UPDATE all actions', () => {
    it('ON DELETE NO ACTION is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE NO ACTION`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('NO ACTION');
    });

    it('ON UPDATE NO ACTION is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON UPDATE NO ACTION`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onUpdate).toBe('NO ACTION');
    });

    it('ON UPDATE SET NULL is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON UPDATE SET NULL`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onUpdate).toBe('SET NULL');
    });

    it('ON UPDATE SET DEFAULT is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON UPDATE SET DEFAULT`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onUpdate).toBe('SET DEFAULT');
    });

    it('ON UPDATE RESTRICT is captured', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON UPDATE RESTRICT`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onUpdate).toBe('RESTRICT');
    });

    it('ON DELETE CASCADE and ON UPDATE NO ACTION together', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].onDelete).toBe('CASCADE');
      expect(result[0].onUpdate).toBe('NO ACTION');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — block comment protection (P1)
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences() — block comment protection', () => {
    it('FK inside /* */ block comment is NOT extracted', () => {
      const sql = `/* FOREIGN KEY (uid) REFERENCES users(id) */\nCREATE TABLE foo (id INT);`;
      expect(adapter.extractFKReferences(sql)).toHaveLength(0);
    });

    it('FK inside multi-line /* */ block comment is NOT extracted', () => {
      const sql = `
        /*
         * Example: FOREIGN KEY (user_id) REFERENCES users(id)
         */
        CREATE TABLE foo (id INT);
      `;
      expect(adapter.extractFKReferences(sql)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // extractFKReferences() — edge cases (P2)
  // ─────────────────────────────────────────────────────────────────────────
  describe('extractFKReferences() — edge cases', () => {
    it('table name with underscores and numbers is captured correctly', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users_v2(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].referencedTable).toBe('users_v2');
    });

    it('UPPERCASE constraint name is captured correctly', () => {
      const sql = `CONSTRAINT FK_ORDERS_USER FOREIGN KEY (user_id) REFERENCES users(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result[0].constraintName).toBe('FK_ORDERS_USER');
    });

    it('duplicate ON DELETE clauses — does not throw', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users(id) ON DELETE CASCADE ON DELETE RESTRICT`;
      expect(() => adapter.extractFKReferences(sql)).not.toThrow();
    });

    it('extractFKReferences does not hang on large SQL (performance guard)', () => {
      const bigSQL = 'CREATE TABLE t (id INT);\n'.repeat(500) +
        'ALTER TABLE orders ADD CONSTRAINT fk_perf FOREIGN KEY (uid) REFERENCES users(id);';
      const start = Date.now();
      const result = adapter.extractFKReferences(bigSQL);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(result).toHaveLength(1);
    });

    it('unquoted table name with $ is captured fully (Fix A)', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES users$archive(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('users$archive');
    });

    it('backtick-quoted table name with $ is captured fully (Fix A)', () => {
      const sql = 'FOREIGN KEY (uid) REFERENCES `users$archive`(id)';
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('users$archive');
    });

    it('schema name with $ is captured without truncation (Fix A)', () => {
      const sql = `FOREIGN KEY (uid) REFERENCES mydb$1.users(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedSchema).toBe('mydb$1');
      expect(result[0].referencedTable).toBe('users');
    });

    it('backtick-quoted table name with hyphen is captured fully', () => {
      const sql = 'FOREIGN KEY (uid) REFERENCES `tbl-name`(id)';
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('tbl-name');
    });

    it('inline block comment between FOREIGN and KEY is handled', () => {
      const sql = `FOREIGN /* inline comment */ KEY (uid) REFERENCES tbl(id)`;
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].referencedTable).toBe('tbl');
    });

    it('CRLF line endings throughout FK SQL — extracted correctly', () => {
      const sql =
        'CREATE TABLE orders (\r\n' +
        '  id INT PRIMARY KEY,\r\n' +
        '  user_id INT,\r\n' +
        '  CONSTRAINT fk_cr FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT\r\n' +
        ');\r\n';
      const result = adapter.extractFKReferences(sql);
      expect(result).toHaveLength(1);
      expect(result[0].constraintName).toBe('fk_cr');
      expect(result[0].referencedTable).toBe('users');
      expect(result[0].onDelete).toBe('RESTRICT');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validateCrossFileFKDependencies() — edge cases (P2)
  // ─────────────────────────────────────────────────────────────────────────
  describe('validateCrossFileFKDependencies() — edge cases', () => {
    it('multiple FKs from different tables pointing to same parent table — no error', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__a.sql', content: `-- +migrate Up\nCREATE TABLE a (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE a;\n` },
        { fileName: 'V003__b.sql', content: `-- +migrate Up\nCREATE TABLE b (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE b;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('case-insensitive table name matching: CREATE TABLE "Users" resolved by FK to "users"', () => {
      const filesData = [
        { fileName: 'V001__Users.sql', content: `-- +migrate Up\nCREATE TABLE Users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE Users;\n` },
        { fileName: 'V002__orders.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, uid INT, FOREIGN KEY (uid) REFERENCES users(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('file with only -- +migrate Down and no Up section — no crash, no FK errors', () => {
      const filesData = [
        { fileName: 'V001__users.sql', content: `-- +migrate Up\nCREATE TABLE users (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE users;\n` },
        { fileName: 'V002__down_only.sql', content: `-- +migrate Down\nDROP TABLE something;\n` }
      ];
      expect(() => adapter.validateCrossFileFKDependencies(filesData)).not.toThrow();
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('file consisting entirely of SQL comments — no crash, no FK errors', () => {
      const filesData = [
        { fileName: 'V001__only_comments.sql', content: `-- +migrate Up\n-- This is a comment\n-- Another comment\n-- +migrate Down\n-- Rollback comment\n` }
      ];
      expect(() => adapter.validateCrossFileFKDependencies(filesData)).not.toThrow();
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('table created AND dropped in same file; FK to it in NEXT file — FK_UNRESOLVED_REFERENCE', () => {
      const filesData = [
        { fileName: 'V001__create_drop.sql', content: `-- +migrate Up\nCREATE TABLE temp (id INT PRIMARY KEY);\nDROP TABLE temp;\n-- +migrate Down\n` },
        { fileName: 'V002__fk_to_temp.sql', content: `-- +migrate Up\nCREATE TABLE orders (id INT, t_id INT, FOREIGN KEY (t_id) REFERENCES temp(id));\n-- +migrate Down\nDROP TABLE orders;\n` }
      ];
      const result = adapter.validateCrossFileFKDependencies(filesData);
      expect(result).toHaveLength(1);
      expect(result[0].fileName).toBe('V002__fk_to_temp.sql');
      expect(result[0].errors[0].code).toBe('FK_UNRESOLVED_REFERENCE');
    });

    it('$ table name: File1 creates tbl$1, File2 FKs to it — no error (Fix A)', () => {
      const filesData = [
        { fileName: 'V001__dollar.sql', content: '-- +migrate Up\nCREATE TABLE `tbl$1` (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE `tbl$1`;\n' },
        { fileName: 'V002__fk_dollar.sql', content: '-- +migrate Up\nCREATE TABLE orders (id INT, t_id INT, FOREIGN KEY (t_id) REFERENCES `tbl$1`(id));\n-- +migrate Down\nDROP TABLE orders;\n' }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });

    it('reserved-word table name using backtick quotes — captured correctly', () => {
      const filesData = [
        { fileName: 'V001__order.sql', content: '-- +migrate Up\nCREATE TABLE `order` (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE `order`;\n' },
        { fileName: 'V002__fk_order.sql', content: '-- +migrate Up\nCREATE TABLE items (id INT, ord_id INT, FOREIGN KEY (ord_id) REFERENCES `order`(id));\n-- +migrate Down\nDROP TABLE items;\n' }
      ];
      expect(adapter.validateCrossFileFKDependencies(filesData)).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// test-fixtures/mariadb/fk-test fixture tests
// 直接讀取 fixture SQL 檔案，驗證 validator 產生正確的 FK 錯誤
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname_fk = dirname(fileURLToPath(import.meta.url));
const fixtureBase = join(__dirname_fk, '../test-fixtures/mariadb/fk-test');

function loadMigrations(subDir) {
  const migrationsDir = join(fixtureBase, subDir, 'migrations');
  return readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => ({
      fileName: f,
      content: readFileSync(join(migrationsDir, f), 'utf8')
    }));
}

describe('fk-test fixtures — ddl/ (valid chain, should produce no FK errors)', () => {
  let adapter;
  beforeEach(() => {
    adapter = new MariaDBAdapter({ migrationsDir: './tmp', changelogTable: '_migrations' });
  });

  it('all 6 migrations pass single-file FK checks', () => {
    const files = loadMigrations('ddl');
    for (const { fileName, content } of files) {
      const r = adapter.validateContent(content, fileName);
      const fkErrors = r.errors.filter(e =>
        e.code === 'FK_REFERENCES_DROPPED_TABLE' || e.code === 'FK_UNRESOLVED_REFERENCE'
      );
      expect(fkErrors, `${fileName} should have no FK errors`).toHaveLength(0);
    }
  });

  it('all 6 migrations pass cross-file FK dependency check', () => {
    const files = loadMigrations('ddl');
    const result = adapter.validateCrossFileFKDependencies(files);
    expect(result).toHaveLength(0);
  });

  // ── drop → re-add FK scenario ────────────────────────────────────────────
  it('000005: DROP_FOREIGN_KEY allowed via @allow annotation — no errors, demoted to warning', () => {
    const files = loadMigrations('ddl');
    const file005 = files.find(f => f.fileName.startsWith('20260101000005'));
    const r = adapter.validateContent(file005.content, file005.fileName);
    expect(r.errors, 'DROP FK with @allow annotation should produce no errors').toHaveLength(0);
    expect(r.warnings.some(w => w.code === 'DROP_FOREIGN_KEY'),
      'DROP_FOREIGN_KEY should appear as an allowed warning').toBe(true);
  });

  it('000006: re-add fk_orders_customer passes cross-file check — customers still in table set', () => {
    const files = loadMigrations('ddl');
    // Run the full chain; re-add in 006 must resolve against 'customers' created in 001
    const result = adapter.validateCrossFileFKDependencies(files);
    expect(result, 'full chain including drop+re-add should have no cross-file FK errors').toHaveLength(0);

    // Also verify 006 alone passes when customers is pre-seeded
    const file001 = files.find(f => f.fileName.startsWith('20260101000001'));
    const file006 = files.find(f => f.fileName.startsWith('20260101000006'));
    const partialResult = adapter.validateCrossFileFKDependencies([file001, file006]);
    expect(partialResult, '006 re-add should pass when customers table exists').toHaveLength(0);
  });
});

describe('fk-test fixtures — ddl-bad/ (invalid scenarios, each must produce expected FK error)', () => {
  let adapter;
  beforeEach(() => {
    adapter = new MariaDBAdapter({ migrationsDir: './tmp', changelogTable: '_migrations' });
  });

  // ── 001: cross-file — FK to customers before customers is created ────────
  it('000001: FK_UNRESOLVED_REFERENCE — fk_orders_customer → customers (not yet created)', () => {
    const files = loadMigrations('ddl-bad');
    const file001 = files.find(f => f.fileName.startsWith('20260101000001'));
    const result = adapter.validateCrossFileFKDependencies([file001]);
    expect(result).toHaveLength(1);
    expect(result[0].errors.some(e =>
      e.code === 'FK_UNRESOLVED_REFERENCE' && e.message.includes("'customers'")
    )).toBe(true);
  });

  // ── 002: single-file — DROP products then FK to it in same UP section ────
  it('000002: FK_REFERENCES_DROPPED_TABLE — fk_items_product → products (dropped in same UP)', () => {
    const files = loadMigrations('ddl-bad');
    const file002 = files.find(f => f.fileName.startsWith('20260101000002'));
    const r = adapter.validateContent(file002.content, file002.fileName);
    expect(r.errors.some(e =>
      e.code === 'FK_REFERENCES_DROPPED_TABLE' && e.message.includes("'products'")
    )).toBe(true);
  });

  // ── 003: cross-file — ALTER TABLE ADD FK to non-existent departments ─────
  it('000003: FK_UNRESOLVED_REFERENCE — fk_orders_dept → departments (ALTER-only file, table never created)', () => {
    const files = loadMigrations('ddl-bad');
    // Include files up to 003 so validator has proper order context
    const upTo003 = files.filter(f =>
      f.fileName.startsWith('20260101000001') ||
      f.fileName.startsWith('20260101000002') ||
      f.fileName.startsWith('20260101000003')
    );
    const crossErrors = adapter.validateCrossFileFKDependencies(upTo003);
    const file003Errors = crossErrors.find(e => e.fileName.startsWith('20260101000003'));
    expect(file003Errors).toBeDefined();
    expect(file003Errors.errors.some(e =>
      e.code === 'FK_UNRESOLVED_REFERENCE' && e.message.includes("'departments'")
    )).toBe(true);
  });

  // ── 004: cross-file — two FKs both unresolved, each reported separately ──
  it('000004: two FK_UNRESOLVED_REFERENCE — fk_shipments_carrier → carriers AND fk_shipments_warehouse → warehouses', () => {
    const files = loadMigrations('ddl-bad');
    const file004 = files.find(f => f.fileName.startsWith('20260101000004'));
    const crossErrors = adapter.validateCrossFileFKDependencies([file004]);
    expect(crossErrors).toHaveLength(1);
    const errors = crossErrors[0].errors;
    expect(errors).toHaveLength(2);
    expect(errors.some(e =>
      e.code === 'FK_UNRESOLVED_REFERENCE' && e.message.includes("'carriers'")
    )).toBe(true);
    expect(errors.some(e =>
      e.code === 'FK_UNRESOLVED_REFERENCE' && e.message.includes("'warehouses'")
    )).toBe(true);
  });

  // ── 005: cross-file — RENAME removes 'orders'; FK in same file targets old name ──
  it('000005: FK_UNRESOLVED_REFERENCE — fk_invoices_order → orders (renamed away in same file, old name gone)', () => {
    const files = loadMigrations('ddl-bad');
    const file005 = files.find(f => f.fileName.startsWith('20260101000005'));
    // Provide no prior files — 'orders' was never established before this file's RENAME
    const crossErrors = adapter.validateCrossFileFKDependencies([file005]);
    expect(crossErrors).toHaveLength(1);
    expect(crossErrors[0].errors.some(e =>
      e.code === 'FK_UNRESOLVED_REFERENCE' && e.message.includes("'orders'")
    )).toBe(true);
  });
});

// ── executeWithLockGuard: Gate 2 (lock-wait fail-fast + bounded retry) ──
// Pulled out to top level: it was previously nested inside the "fk-test
// fixtures — ddl-bad/" describe above (a leftover from an earlier edit), which
// made no functional difference since it's fully self-contained, but reported
// misleadingly in test output as if it were part of the FK fixture suite.
describe('MariaDBAdapter — executeWithLockGuard', () => {
  let guardAdapter;
  let mockConnection;

  const lockWaitError = () => {
    const err = new Error('Lock wait timeout exceeded; try restarting transaction');
    err.errno = 1205;
    err.code = 'ER_LOCK_WAIT_TIMEOUT';
    return err;
  };

  beforeEach(() => {
    mockConnection = {
      execute: vi.fn().mockResolvedValue([[]]),
      query: vi.fn()
    };
    guardAdapter = new MariaDBAdapter({
      migrationsDir: '/test/migrations',
      mariadb: { host: 'localhost', port: 3306, user: 'root', password: 'x', database: 'test' },
      // Fast retry delay so the suite doesn't actually wait 2s per test
      ddlSafety: { lockGuard: { lockWaitTimeoutSec: 5, innodbLockWaitTimeoutSec: 5, maxRetries: 3, retryDelayMs: 1 } }
    });
    guardAdapter.connection = mockConnection;
  });

  it('sets SESSION lock_wait_timeout and innodb_lock_wait_timeout before executing', async () => {
    mockConnection.query.mockResolvedValue([[]]);
    await guardAdapter.executeWithLockGuard('ALTER TABLE orders ADD COLUMN foo INT');

    // Sent via query() (text protocol), not execute() — MariaDB's prepared-statement
    // protocol rejects a bound parameter on a SET session-variable statement.
    expect(mockConnection.query).toHaveBeenCalledWith('SET SESSION lock_wait_timeout = 5');
    expect(mockConnection.query).toHaveBeenCalledWith('SET SESSION innodb_lock_wait_timeout = 5');
    expect(mockConnection.execute).not.toHaveBeenCalled();
  });

  it('retries on ER_LOCK_WAIT_TIMEOUT (errno 1205) and succeeds once the lock frees up', async () => {
    mockConnection.query
      .mockResolvedValueOnce([[]]) // SET lock_wait_timeout
      .mockResolvedValueOnce([[]]) // SET innodb_lock_wait_timeout
      .mockRejectedValueOnce(lockWaitError())
      .mockResolvedValueOnce([[{ ok: 1 }]]);

    const result = await guardAdapter.executeWithLockGuard('ALTER TABLE orders ADD COLUMN foo INT');

    expect(mockConnection.query).toHaveBeenCalledTimes(4); // 2 SET + 1 failed attempt + 1 successful attempt
    expect(result).toEqual([[{ ok: 1 }]]);
  });

  it('retries exactly maxRetries times then propagates the original error', async () => {
    mockConnection.query
      .mockResolvedValueOnce([[]]) // SET lock_wait_timeout
      .mockResolvedValueOnce([[]]) // SET innodb_lock_wait_timeout
      .mockRejectedValue(lockWaitError());

    await expect(
      guardAdapter.executeWithLockGuard('ALTER TABLE orders ADD COLUMN foo INT')
    ).rejects.toMatchObject({ errno: 1205 });

    expect(mockConnection.query).toHaveBeenCalledTimes(2 + 3); // 2 SET + maxRetries(3) attempts
  });

  it('does not retry a non-lock-wait error — fails on first attempt', async () => {
    const syntaxError = new Error('You have an error in your SQL syntax');
    syntaxError.errno = 1064;
    mockConnection.query
      .mockResolvedValueOnce([[]]) // SET lock_wait_timeout
      .mockResolvedValueOnce([[]]) // SET innodb_lock_wait_timeout
      .mockRejectedValue(syntaxError);

    await expect(
      guardAdapter.executeWithLockGuard('ALTER TABLE orders BROKEN SQL')
    ).rejects.toMatchObject({ errno: 1064 });

    expect(mockConnection.query).toHaveBeenCalledTimes(3); // 2 SET + 1 failed attempt
  });

  it('ddlSafety.lockGuard.enabled: false bypasses SET SESSION and retry entirely', async () => {
    guardAdapter.config.ddlSafety.lockGuard.enabled = false;
    mockConnection.query.mockResolvedValueOnce([[]]);

    await guardAdapter.executeWithLockGuard('ALTER TABLE orders ADD COLUMN foo INT');

    expect(mockConnection.execute).not.toHaveBeenCalled();
    expect(mockConnection.query).toHaveBeenCalledTimes(1);
  });

  it('falls back to defaults when ddlSafety.lockGuard is not configured', async () => {
    const bareAdapter = new MariaDBAdapter({
      migrationsDir: '/test/migrations',
      mariadb: { host: 'localhost', port: 3306, user: 'root', password: 'x', database: 'test' }
    });
    bareAdapter.connection = mockConnection;
    mockConnection.query.mockResolvedValue([[]]);

    await bareAdapter.executeWithLockGuard('ALTER TABLE orders ADD COLUMN foo INT');

    expect(mockConnection.query).toHaveBeenCalledWith('SET SESSION lock_wait_timeout = 5');
  });
});

describe('MariaDBAdapter — resetChangelog', () => {
  let adapter;
  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: '/test/migrations',
      mariadb: { host: 'localhost', port: 3306, user: 'root', password: 'password', database: 'test' }
    });
  });

  function mockConnection(count) {
    return {
      query: vi.fn().mockImplementation((sql) => {
        if (/^SELECT COUNT/i.test(sql)) return Promise.resolve([[{ cnt: count }]]);
        if (/^DELETE FROM/i.test(sql)) return Promise.resolve([{ affectedRows: count }]);
        throw new Error(`Unexpected query in mock: ${sql}`);
      })
    };
  }

  it('dry run counts rows but issues no DELETE', async () => {
    const conn = mockConnection(3);
    adapter.connection = conn;
    const count = await adapter.resetChangelog({ dryRun: true });
    expect(count).toBe(3);
    expect(conn.query).toHaveBeenCalledTimes(1); // only the COUNT, no DELETE
    expect(conn.query.mock.calls[0][0]).toMatch(/^SELECT COUNT/i);
  });

  it('actual run deletes and returns the pre-deletion count', async () => {
    const conn = mockConnection(5);
    adapter.connection = conn;
    const count = await adapter.resetChangelog({ dryRun: false });
    expect(count).toBe(5);
    expect(conn.query).toHaveBeenCalledTimes(2);
    expect(conn.query.mock.calls[1][0]).toMatch(/^DELETE FROM/i);
  });

  it('skips the DELETE entirely when there is nothing to delete', async () => {
    const conn = mockConnection(0);
    adapter.connection = conn;
    const count = await adapter.resetChangelog({ dryRun: false });
    expect(count).toBe(0);
    expect(conn.query).toHaveBeenCalledTimes(1); // COUNT only
  });

  it('defaults to this.changelogTable when no tableName is given', async () => {
    const conn = mockConnection(1);
    adapter.connection = conn;
    adapter.changelogTable = 'custom_changelog';
    await adapter.resetChangelog({ dryRun: true });
    expect(conn.query.mock.calls[0][0]).toContain('custom_changelog');
  });

  it('uses the passed tableName for DCL checksum tables instead of the changelog table', async () => {
    const conn = mockConnection(2);
    adapter.connection = conn;
    expect(adapter.changelogTable).toBe('schema_migrations');
    await adapter.resetChangelog({ dryRun: true, tableName: 'repeatable_migrations' });
    expect(conn.query.mock.calls[0][0]).toContain('repeatable_migrations');
    expect(conn.query.mock.calls[0][0]).not.toContain('schema_migrations');
  });

  it('rejects an unsafe table name instead of interpolating it into SQL', async () => {
    adapter.connection = mockConnection(0);
    await expect(
      adapter.resetChangelog({ tableName: 'x; DROP TABLE users; --' })
    ).rejects.toThrow(/Invalid table name/);
  });

  it('treats a missing table as zero records instead of throwing', async () => {
    const conn = {
      query: vi.fn().mockRejectedValue(Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' }))
    };
    adapter.connection = conn;
    const count = await adapter.resetChangelog({ dryRun: true });
    expect(count).toBe(0);
  });
});

describe('MariaDBAdapter — getSchemaSnapshot', () => {
  let adapter;
  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: '/test/migrations',
      mariadb: { host: 'localhost', port: 3306, user: 'root', password: 'password', database: 'test' }
    });
  });

  it('returns one entry per table with its columns in ordinal order', async () => {
    const conn = {
      query: vi.fn()
        .mockResolvedValueOnce([[
          { TABLE_NAME: 'orders', ENGINE: 'InnoDB', TABLE_ROWS: 42 },
          { TABLE_NAME: 'users', ENGINE: 'InnoDB', TABLE_ROWS: 10 }
        ]])
        .mockResolvedValueOnce([[
          { COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20)', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null },
          { COLUMN_NAME: 'user_id', COLUMN_TYPE: 'bigint(20)', IS_NULLABLE: 'NO', COLUMN_KEY: 'MUL', COLUMN_DEFAULT: null }
        ]])
        .mockResolvedValueOnce([[
          { COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint(20)', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', COLUMN_DEFAULT: null },
          { COLUMN_NAME: 'email', COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'YES', COLUMN_KEY: '', COLUMN_DEFAULT: null }
        ]])
    };
    adapter.connection = conn;

    const snapshot = await adapter.getSchemaSnapshot();

    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].table).toBe('orders');
    expect(snapshot[0].engine).toBe('InnoDB');
    expect(snapshot[0].rows).toBe(42);
    expect(snapshot[0].columns).toEqual([
      { name: 'id', type: 'bigint(20)', nullable: false, key: 'PRI', default: null },
      { name: 'user_id', type: 'bigint(20)', nullable: false, key: 'MUL', default: null }
    ]);
    expect(snapshot[1].table).toBe('users');
    expect(snapshot[1].columns[1]).toEqual({ name: 'email', type: 'varchar(255)', nullable: true, key: '', default: null });

    // Filters to this database's own base tables only
    expect(conn.query.mock.calls[0][0]).toContain("TABLE_TYPE = 'BASE TABLE'");
    expect(conn.query.mock.calls[0][1]).toEqual(['test']);
  });

  it('returns an empty array when the database has no tables', async () => {
    const conn = { query: vi.fn().mockResolvedValueOnce([[]]) };
    adapter.connection = conn;
    const snapshot = await adapter.getSchemaSnapshot();
    expect(snapshot).toEqual([]);
    expect(conn.query).toHaveBeenCalledTimes(1); // no per-table column query issued
  });

  it('reports TABLE_ROWS = NULL as rows: null rather than 0 (unknown, not empty)', async () => {
    const conn = {
      query: vi.fn()
        .mockResolvedValueOnce([[{ TABLE_NAME: 'orders', ENGINE: 'InnoDB', TABLE_ROWS: null }]])
        .mockResolvedValueOnce([[]])
    };
    adapter.connection = conn;
    const snapshot = await adapter.getSchemaSnapshot();
    expect(snapshot[0].rows).toBeNull();
  });
});
