/**
 * Test cases for SQL/JS normalization and pattern matching edge cases
 * 
 * Tests various edge cases:
 * - Case variations (lowercase, uppercase, mixed)
 * - Multiple whitespace
 * - Newlines
 * - Comments (single-line, multi-line)
 * - Various quote styles
 * - Schema prefixes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

describe('MariaDB Adapter - Normalization & Pattern Matching', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: './test-migrations',
      changelogTable: 'test_changelog'
    });
  });

  describe('normalizeSQL()', () => {
    it('should remove single-line comments', () => {
      const sql = `DROP TABLE users; -- this is a comment
      CREATE TABLE test;`;
      const normalized = adapter.normalizeSQL(sql);
      expect(normalized).toBe('DROP TABLE users; CREATE TABLE test;');
    });

    it('should remove multi-line comments', () => {
      const sql = `DROP /* this is a 
      multi-line comment */ TABLE users;`;
      const normalized = adapter.normalizeSQL(sql);
      expect(normalized).toBe('DROP TABLE users;');
    });

    it('should collapse multiple whitespace', () => {
      const sql = `DROP    TABLE     users;`;
      const normalized = adapter.normalizeSQL(sql);
      expect(normalized).toBe('DROP TABLE users;');
    });

    it('should collapse newlines', () => {
      const sql = `DROP
      TABLE
      users;`;
      const normalized = adapter.normalizeSQL(sql);
      expect(normalized).toBe('DROP TABLE users;');
    });

    it('should preserve EXPECT directives', () => {
      const sql = `-- EXPECT_ROWS: SELECT 1 FROM users;
      -- EXPECT_NO_ROWS: SELECT 1 FROM deleted;`;
      const normalized = adapter.normalizeSQL(sql);
      expect(normalized).toContain('EXPECT_ROWS');
      expect(normalized).toContain('EXPECT_NO_ROWS');
    });
  });

  describe('Pattern Matching - Case Variations', () => {
    const testCases = [
      { name: 'lowercase', sql: 'drop database mydb;' },
      { name: 'uppercase', sql: 'DROP DATABASE MYDB;' },
      { name: 'mixed case', sql: 'Drop Database MyDB;' },
      { name: 'random case', sql: 'dRoP dAtAbAsE mydb;' },
    ];

    testCases.forEach(({ name, sql }) => {
      it(`should detect DROP DATABASE with ${name}`, () => {
        const content = `-- +migrate Up\n${sql}\n-- +migrate Down\n`;
        const result = adapter.validateContent(content, 'test.sql');
        expect(result.valid).toBe(false);
        expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
      });
    });
  });

  describe('Pattern Matching - Whitespace Variations', () => {
    it('should detect DROP DATABASE with multiple spaces', () => {
      const content = `-- +migrate Up\nDROP   DATABASE   mydb;\n-- +migrate Down\n`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should detect DROP DATABASE with newline', () => {
      const content = `-- +migrate Up\nDROP\n  DATABASE\n  mydb;\n-- +migrate Down\n`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should detect DROP DATABASE with tabs', () => {
      const content = `-- +migrate Up\nDROP\tDATABASE\tmydb;\n-- +migrate Down\n`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });
  });

  describe('Pattern Matching - Comment Bypass Attempts', () => {
    it('should detect DROP DATABASE hidden in multi-line comment (normalized away)', () => {
      const content = `-- +migrate Up
DROP /* sneaky */ DATABASE /* attempt */ mydb;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should NOT detect DROP DATABASE fully inside comment', () => {
      const content = `-- +migrate Up
-- DROP DATABASE mydb;
SELECT 1;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(false);
    });

    it('should detect TRUNCATE TABLE with comment in between', () => {
      const content = `-- +migrate Up
TRUNCATE /* clear all */ TABLE users;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'TRUNCATE_TABLE')).toBe(true);
    });
  });

  describe('Pattern Matching - Quote Variations', () => {
    it('should detect CREATE USER with backtick quotes', () => {
      const content = `-- +migrate Up
CREATE USER \`app_user\`@'%' IDENTIFIED BY 'pass';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(true);
    });

    it('should detect CREATE USER with double quotes', () => {
      const content = `-- +migrate Up
CREATE USER "app_user"@'%' IDENTIFIED BY 'pass';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(true);
    });

    it('should detect CREATE USER with single quotes', () => {
      const content = `-- +migrate Up
CREATE USER 'app_user'@'%' IDENTIFIED BY 'pass';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(true);
    });
  });

  describe('Pattern Matching - GRANT Variations', () => {
    it('should detect GRANT SELECT', () => {
      const content = `-- +migrate Up
GRANT SELECT ON mydb.* TO 'user'@'%';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(true);
    });

    it('should detect GRANT ALL PRIVILEGES', () => {
      const content = `-- +migrate Up
GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(true);
    });

    it('should detect GRANT with newline', () => {
      const content = `-- +migrate Up
GRANT
  SELECT,
  INSERT
ON mydb.* TO 'user'@'%';
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(true);
    });
  });

  describe('Pattern Matching - ALTER TABLE Variations', () => {
    it('should detect ALTER TABLE ADD COLUMN with various spacing', () => {
      const content = `-- +migrate Up
ALTER   TABLE   users   ADD   COLUMN   email   VARCHAR(255);
-- +migrate Down
ALTER TABLE users DROP COLUMN email;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'ALTER_TABLE_BLOCKING')).toBe(true);
    });

    it('should detect ALTER TABLE with backtick table name', () => {
      const content = `-- +migrate Up
ALTER TABLE \`user-data\` ADD COLUMN status INT;
-- +migrate Down
ALTER TABLE \`user-data\` DROP COLUMN status;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'ALTER_TABLE_BLOCKING')).toBe(true);
    });
  });

  describe('Pattern Matching - LOCK TABLE Variations', () => {
    it('should detect LOCK TABLE (singular)', () => {
      const content = `-- +migrate Up
LOCK TABLE users WRITE;
-- do something
UNLOCK TABLES;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'LOCK_TABLE')).toBe(true);
    });

    it('should detect LOCK TABLES (plural)', () => {
      const content = `-- +migrate Up
LOCK TABLES users WRITE, orders READ;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'LOCK_TABLE')).toBe(true);
    });
  });
});

describe('MongoDB Adapter - Normalization & Pattern Matching', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MongoDBAdapter({
      migrationsDir: './test-migrations',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'test_db'
      }
    });
  });

  describe('normalizeJS()', () => {
    it('should remove single-line comments', () => {
      const js = `db.dropDatabase(); // this is a comment
      db.createCollection(collName);`;  // Use variable instead of string
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe(`db.dropDatabase(); db.createCollection(collName);`);
    });

    it('should remove multi-line comments', () => {
      const js = `db./* this is a 
      multi-line comment */dropDatabase();`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe('db. dropDatabase();');
    });

    it('should collapse multiple whitespace', () => {
      const js = `db.    dropDatabase   (   );`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe('db. dropDatabase ( );');
    });

    it('should collapse newlines', () => {
      const js = `db
        .dropDatabase
        ();`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe('db .dropDatabase ();');
    });

    it('should replace string literals with placeholder to prevent false positives', () => {
      // String values should be replaced to prevent dangerous keyword detection in strings
      const js = `const url = 'mongodb://localhost:27017';`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe("const url = '__STRING__';");
      // This is correct behavior - string contents are hidden
    });
  });

  describe('Pattern Matching - Case Variations', () => {
    const makeContent = (code) => `
export async function up(db, client) {
  ${code}
}
export async function down(db, client) {
  console.log('rollback');
}
`;

    it('should detect .dropDatabase() case-insensitive', () => {
      const content = makeContent(`await db.dropDatabase();`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should detect dropDatabase command', () => {
      const content = makeContent(`await db.command({ dropDatabase: 1 });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE_CMD')).toBe(true);
    });
  });

  describe('Pattern Matching - User Management', () => {
    const makeContent = (code) => `
export async function up(db, client) {
  ${code}
}
export async function down(db, client) {}
`;

    it('should detect .createUser()', () => {
      const content = makeContent(`await adminDb.createUser({ user: 'test' });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(true);
    });

    it('should detect createUser command', () => {
      const content = makeContent(`await adminDb.command({ createUser: 'test', pwd: 'pass', roles: [] });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER_CMD')).toBe(true);
    });

    it('should detect .dropUser()', () => {
      const content = makeContent(`await adminDb.dropUser('olduser');`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_USER')).toBe(true);
    });

    it('should detect grantRolesToUser', () => {
      const content = makeContent(`await adminDb.command({ grantRolesToUser: 'test', roles: ['read'] });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'GRANT_ROLES_CMD')).toBe(true);
    });
  });

  describe('Pattern Matching - Dangerous Operations', () => {
    const makeContent = (code) => `
export async function up(db, client) {
  ${code}
}
export async function down(db, client) {}
`;

    it('should detect .deleteMany({})', () => {
      const content = makeContent(`await db.collection('users').deleteMany({});`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'DELETE_ALL')).toBe(true);
    });

    it('should detect .deleteMany with empty object and spaces', () => {
      const content = makeContent(`await db.collection('users').deleteMany(  {   }  );`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'DELETE_ALL')).toBe(true);
    });

    it('should detect .updateMany({}, ...)', () => {
      const content = makeContent(`await db.collection('users').updateMany({}, { $set: { status: 'active' } });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'UPDATE_ALL')).toBe(true);
    });

    it('should detect .drop()', () => {
      const content = makeContent(`await db.collection('temp').drop();`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'DROP_COLLECTION')).toBe(true);
    });

    it('should detect $unset operator', () => {
      const content = makeContent(`await db.collection('users').updateMany({}, { $unset: { oldField: 1 } });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'UNSET_FIELD')).toBe(true);
    });

    it('should detect $rename operator', () => {
      const content = makeContent(`await db.collection('users').updateMany({}, { $rename: { old: 'new' } });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'RENAME_FIELD')).toBe(true);
    });
  });

  describe('Pattern Matching - Comment Bypass Attempts', () => {
    const makeContent = (code) => `
export async function up(db, client) {
  ${code}
}
export async function down(db, client) {}
`;

    it('should detect dropDatabase hidden with comments', () => {
      const content = makeContent(`await db /* sneaky */.dropDatabase /* attempt */();`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should NOT detect dropDatabase fully inside comment', () => {
      const content = makeContent(`// db.dropDatabase();
      await db.createCollection('test');`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(false);
    });

    it('should detect deleteMany with newlines', () => {
      const content = makeContent(`await db
        .collection('users')
        .deleteMany(
          {}
        );`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'DELETE_ALL')).toBe(true);
    });
  });

  describe('Pattern Matching - Whitespace Variations', () => {
    const makeContent = (code) => `
export async function up(db, client) {
  ${code}
}
export async function down(db, client) {}
`;

    it('should detect .drop() with spaces', () => {
      const content = makeContent(`await db.collection('test').drop   (   );`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.dangerousOps.some(op => op.code === 'DROP_COLLECTION')).toBe(true);
    });

    it('should detect createUser with newlines in command', () => {
      const content = makeContent(`await adminDb.command({
        createUser: 'test',
        pwd: 'password',
        roles: []
      });`);
      const result = adapter.validateContent(content, 'test.js');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER_CMD')).toBe(true);
    });
  });
});

describe('Cross-Adapter Edge Cases', () => {
  describe('Empty and null handling', () => {
    it('MariaDB: should handle empty content', () => {
      const adapter = new MariaDBAdapter({ migrationsDir: '.', changelogTable: 'test' });
      const result = adapter.validateContent('', 'empty.sql');
      expect(result.valid).toBe(true);
    });

    it('MariaDB: should handle null in normalizeSQL', () => {
      const adapter = new MariaDBAdapter({ migrationsDir: '.', changelogTable: 'test' });
      expect(adapter.normalizeSQL(null)).toBe('');
      expect(adapter.normalizeSQL(undefined)).toBe('');
    });

    it('MongoDB: should handle empty content', () => {
      const adapter = new MongoDBAdapter({ migrationsDir: '.', mongodb: { url: 'mongodb://localhost', databaseName: 'test' } });
      const result = adapter.validateContent('', 'empty.js');
      expect(result.valid).toBe(true);
    });

    it('MongoDB: should handle null in normalizeJS', () => {
      const adapter = new MongoDBAdapter({ migrationsDir: '.', mongodb: { url: 'mongodb://localhost', databaseName: 'test' } });
      expect(adapter.normalizeJS(null)).toBe('');
      expect(adapter.normalizeJS(undefined)).toBe('');
    });
  });
});
// ========================================
// 🆕 新增：字串常量誤判測試 & 可疑名稱警告測試
// ========================================
describe('MariaDB - String Literal False Positive Prevention', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: './test-migrations',
      changelogTable: 'test_changelog'
    });
  });

  describe('String literals should NOT trigger false positives', () => {
    it('should NOT detect DROP DATABASE inside single-quoted string', () => {
      const content = `-- +migrate Up
INSERT INTO audit_log (action, details) VALUES ('user_action', 'DROP DATABASE test');
-- +migrate Down
DELETE FROM audit_log WHERE action = 'user_action';
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(false);
    });

    it('should NOT detect TRUNCATE TABLE inside double-quoted string', () => {
      const content = `-- +migrate Up
INSERT INTO command_history (cmd) VALUES ("TRUNCATE TABLE users");
-- +migrate Down
DELETE FROM command_history;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'TRUNCATE_TABLE')).toBe(false);
    });

    it('should NOT detect SHUTDOWN inside a string value', () => {
      const content = `-- +migrate Up
CREATE TABLE commands (
  id INT PRIMARY KEY,
  name VARCHAR(100)
);
INSERT INTO commands VALUES (1, 'SHUTDOWN');
-- +migrate Down
DROP TABLE commands;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'SHUTDOWN')).toBe(false);
    });

    it('should NOT detect GRANT inside a log message', () => {
      const content = `-- +migrate Up
INSERT INTO permissions_log (msg) VALUES ('Admin executed GRANT ALL PRIVILEGES on production');
-- +migrate Down
DELETE FROM permissions_log;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'GRANT')).toBe(false);
    });

    it('should NOT detect CREATE USER inside escaped string', () => {
      const content = `-- +migrate Up
INSERT INTO sql_templates (template) VALUES ('CREATE USER \\'app_user\\'@\\'%\\' IDENTIFIED BY \\'pass\\';');
-- +migrate Down
DELETE FROM sql_templates;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'CREATE_USER')).toBe(false);
    });

    it('should still detect REAL DROP DATABASE outside of strings', () => {
      const content = `-- +migrate Up
INSERT INTO log (msg) VALUES ('safe message');
DROP DATABASE production;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.forbiddenOps.some(op => op.code === 'DROP_DATABASE')).toBe(true);
    });

    it('should detect TRUNCATE TABLE even with string before it', () => {
      const content = `-- +migrate Up
INSERT INTO log (msg) VALUES ('cleaning up');
TRUNCATE TABLE temp_data;
-- +migrate Down
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.dangerousOps.some(op => op.code === 'TRUNCATE_TABLE')).toBe(true);
    });
  });
});

describe('MariaDB - Suspicious Name Detection', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: './test-migrations',
      changelogTable: 'test_changelog'
    });
  });

  describe('extractIdentifiers()', () => {
    it('should extract backtick-quoted identifiers', () => {
      const sql = 'CREATE TABLE `user_data` (id INT);';
      const identifiers = adapter.extractIdentifiers(sql);
      expect(identifiers).toContain('user_data');
    });

    it('should extract table names from CREATE TABLE', () => {
      const sql = 'CREATE TABLE IF NOT EXISTS my_table (id INT);';
      const identifiers = adapter.extractIdentifiers(sql);
      expect(identifiers).toContain('my_table');
    });

    it('should extract column names from ADD COLUMN', () => {
      const sql = 'ALTER TABLE users ADD COLUMN grant_type VARCHAR(50);';
      const identifiers = adapter.extractIdentifiers(sql);
      expect(identifiers).toContain('grant_type');
    });

    it('should extract multiple identifiers', () => {
      const sql = `
        CREATE TABLE \`drop_database_backup\` (id INT);
        ALTER TABLE users ADD COLUMN truncate_flag BOOLEAN;
      `;
      const identifiers = adapter.extractIdentifiers(sql);
      expect(identifiers).toContain('drop_database_backup');
      expect(identifiers).toContain('truncate_flag');
    });
  });

  describe('checkSuspiciousNames()', () => {
    it('should warn when table name contains drop_database', () => {
      const sql = 'CREATE TABLE drop_database_backup (id INT);';
      const warnings = adapter.checkSuspiciousNames(sql);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].keyword).toBe('drop_database');
    });

    it('should warn when column name contains truncate', () => {
      const sql = 'ALTER TABLE users ADD COLUMN truncate_flag INT;';
      const warnings = adapter.checkSuspiciousNames(sql);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].keyword).toBe('truncate');
    });

    it('should warn when table name contains shutdown', () => {
      const sql = 'CREATE TABLE `shutdown_log` (id INT, message TEXT);';
      const warnings = adapter.checkSuspiciousNames(sql);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].keyword).toBe('shutdown');
    });

    it('should NOT warn for normal table names', () => {
      const sql = 'CREATE TABLE users (id INT, email VARCHAR(255));';
      const warnings = adapter.checkSuspiciousNames(sql);
      expect(warnings.length).toBe(0);
    });

    it('should NOT warn for partial matches that are not dangerous', () => {
      const sql = 'CREATE TABLE user_settings (id INT);';
      const warnings = adapter.checkSuspiciousNames(sql);
      expect(warnings.length).toBe(0);
    });
  });

  describe('validateContent() with suspicious names', () => {
    it('should include suspicious name warnings in validation result', () => {
      const content = `-- +migrate Up
CREATE TABLE drop_database_history (
  id INT PRIMARY KEY,
  event_time DATETIME
);
-- +migrate Down
DROP TABLE drop_database_history;
`;
      const result = adapter.validateContent(content, 'test.sql');
      expect(result.suspiciousNames).toBeDefined();
      expect(result.suspiciousNames.length).toBeGreaterThan(0);
      expect(result.summary.suspiciousNames).toBeGreaterThan(0);
    });

    it('should still be valid with suspicious names (warning only) when CREATE/DROP match', () => {
      const content = `-- +migrate Up
CREATE TABLE shutdown_events (
  id INT PRIMARY KEY
);
-- +migrate Down
DROP TABLE shutdown_events;
`;
      const result = adapter.validateContent(content, 'test.sql');
      // Should be valid because:
      // 1. suspicious names are warnings, not errors
      // 2. CREATE/DROP pair matches (shutdown_events created and dropped)
      expect(result.valid).toBe(true);
      expect(result.suspiciousNames.length).toBeGreaterThan(0);
      // Verify it's a warning about the suspicious name
      expect(result.suspiciousNames[0].keyword).toBe('shutdown');
    });

    it('should detect both real dangerous ops AND suspicious names', () => {
      const content = `-- +migrate Up
CREATE TABLE grant_all_history (id INT);
TRUNCATE TABLE old_data;
-- +migrate Down
DROP TABLE grant_all_history;
`;
      const result = adapter.validateContent(content, 'test.sql');
      // TRUNCATE should be detected as dangerous
      expect(result.dangerousOps.some(op => op.code === 'TRUNCATE_TABLE')).toBe(true);
      // grant_all should be detected as suspicious name
      expect(result.suspiciousNames.length).toBeGreaterThan(0);
    });
  });
});

describe('MariaDB - normalizeSQL String Protection', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: './test-migrations',
      changelogTable: 'test_changelog'
    });
  });

  it('should replace single-quoted strings with placeholder', () => {
    const sql = "INSERT INTO t VALUES ('DROP DATABASE test');";
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('__STRING__');
    expect(normalized).not.toContain('DROP DATABASE test');
  });

  it('should replace double-quoted strings with placeholder', () => {
    const sql = 'INSERT INTO t VALUES ("TRUNCATE TABLE users");';
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('__STRING__');
    expect(normalized).not.toContain('TRUNCATE TABLE users');
  });

  it('should handle escaped quotes inside strings', () => {
    const sql = "INSERT INTO t VALUES ('It\\'s a test with DROP DATABASE');";
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('__STRING__');
    expect(normalized).not.toContain('DROP DATABASE');
  });

  it('should handle multiple strings in one statement', () => {
    const sql = "INSERT INTO t (a, b) VALUES ('DROP', 'DATABASE');";
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).not.toContain("'DROP'");
    expect(normalized).not.toContain("'DATABASE'");
    expect(normalized.match(/__STRING__/g).length).toBe(2);
  });

  it('should preserve SQL keywords outside strings', () => {
    const sql = "INSERT INTO users (name) VALUES ('test'); DROP TABLE temp;";
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('DROP TABLE temp');
    expect(normalized).toContain('__STRING__');
  });

  it('should handle empty strings', () => {
    const sql = "INSERT INTO t VALUES ('');";
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('__STRING__');
  });

  it('should handle strings with newlines', () => {
    const sql = `INSERT INTO t VALUES ('line1
line2
DROP DATABASE test');`;
    const normalized = adapter.normalizeSQL(sql);
    expect(normalized).toContain('__STRING__');
    expect(normalized).not.toContain('DROP DATABASE test');
  });
});

// ========================================
// 🆕 效能檢測測試
// ========================================
describe('MariaDB - Performance Issue Detection', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MariaDBAdapter({
      migrationsDir: './test-migrations',
      changelogTable: 'test_changelog'
    });
  });

  describe('splitStatements()', () => {
    it('should split simple statements', () => {
      const sql = 'SELECT 1; SELECT 2; SELECT 3;';
      const statements = adapter.splitStatements(sql);
      expect(statements).toHaveLength(3);
    });

    it('should handle statements without trailing semicolon', () => {
      const sql = 'SELECT 1; SELECT 2';
      const statements = adapter.splitStatements(sql);
      expect(statements).toHaveLength(2);
    });

    it('should not split on semicolon inside string', () => {
      const sql = "INSERT INTO t VALUES ('a;b;c'); SELECT 1;";
      const statements = adapter.splitStatements(sql);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain('a;b;c');
    });

    it('should handle empty input', () => {
      expect(adapter.splitStatements('')).toHaveLength(0);
      expect(adapter.splitStatements(null)).toHaveLength(0);
    });

    it('should remove comments before splitting', () => {
      const sql = `
        -- Comment 1
        SELECT 1;
        /* Multi-line
           comment */
        SELECT 2;
      `;
      const statements = adapter.splitStatements(sql);
      expect(statements).toHaveLength(2);
    });
  });

  describe('checkPerformanceIssues() - Query Length', () => {
    it('should warn when a single query is too long', () => {
      // Create a very long query (> 5000 chars)
      const longColumn = 'a'.repeat(5100);
      const sql = `SELECT '${longColumn}' FROM users;`;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'QUERY_TOO_LONG')).toBe(true);
      expect(result.metrics.longStatements).toBeDefined();
    });

    it('should warn when total migration is too long', () => {
      // Create content > 50000 chars
      const statements = Array(100).fill("INSERT INTO t VALUES ('data');").join('\n');
      const longSQL = statements.repeat(20);
      const result = adapter.checkPerformanceIssues(longSQL);
      
      expect(result.warnings.some(w => w.code === 'MIGRATION_TOO_LONG')).toBe(true);
    });

    it('should NOT warn for normal length queries', () => {
      const sql = 'SELECT id, name FROM users WHERE active = 1;';
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'QUERY_TOO_LONG')).toBe(false);
    });
  });

  describe('checkPerformanceIssues() - Index Count', () => {
    it('should warn when creating too many indexes', () => {
      const sql = `
        CREATE INDEX idx1 ON users (name);
        CREATE INDEX idx2 ON users (email);
        CREATE INDEX idx3 ON orders (user_id);
        CREATE INDEX idx4 ON orders (status);
        CREATE INDEX idx5 ON products (category);
        CREATE INDEX idx6 ON products (price);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_INDEXES')).toBe(true);
      expect(result.metrics.indexCount).toBe(6);
    });

    it('should warn about multiple indexes on same table', () => {
      const sql = `
        CREATE INDEX idx1 ON users (name);
        CREATE INDEX idx2 ON users (email);
        CREATE INDEX idx3 ON users (created_at);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'MULTIPLE_INDEXES_SAME_TABLE')).toBe(true);
    });

    it('should NOT warn for reasonable index count', () => {
      const sql = `
        CREATE INDEX idx1 ON users (name);
        CREATE INDEX idx2 ON orders (user_id);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_INDEXES')).toBe(false);
    });
  });

  describe('checkPerformanceIssues() - ALTER TABLE Count', () => {
    it('should warn when too many ALTER TABLE statements', () => {
      const alterStatements = Array(12).fill(0).map((_, i) => 
        `ALTER TABLE users ADD COLUMN col${i} VARCHAR(100);`
      ).join('\n');
      
      const result = adapter.checkPerformanceIssues(alterStatements);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_ALTER_TABLES')).toBe(true);
      expect(result.metrics.alterTableCount).toBe(12);
    });

    it('should NOT warn for reasonable ALTER TABLE count', () => {
      const sql = `
        ALTER TABLE users ADD COLUMN email VARCHAR(255);
        ALTER TABLE users ADD COLUMN phone VARCHAR(20);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_ALTER_TABLES')).toBe(false);
    });
  });

  describe('checkPerformanceIssues() - Statement Count', () => {
    it('should warn when too many statements in migration', () => {
      const statements = Array(55).fill('INSERT INTO t VALUES (1);').join('\n');
      const result = adapter.checkPerformanceIssues(statements);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_STATEMENTS')).toBe(true);
      expect(result.metrics.statementCount).toBe(55);
    });
  });

  describe('checkPerformanceIssues() - Query Complexity', () => {
    it('should warn about SELECT *', () => {
      const sql = 'SELECT * FROM users WHERE id = 1;';
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'SELECT_STAR')).toBe(true);
    });

    it('should warn about too many JOINs', () => {
      const sql = `
        SELECT u.name, o.id, p.name, c.name, s.name, r.name
        FROM users u
        JOIN orders o ON u.id = o.user_id
        JOIN products p ON o.product_id = p.id
        JOIN categories c ON p.category_id = c.id
        JOIN suppliers s ON p.supplier_id = s.id
        JOIN regions r ON s.region_id = r.id
        JOIN countries co ON r.country_id = co.id;
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_JOINS')).toBe(true);
      expect(result.metrics.joinCount).toBeGreaterThan(5);
    });

    it('should warn about too many subqueries', () => {
      const sql = `
        SELECT * FROM users 
        WHERE id IN (SELECT user_id FROM orders WHERE status = 'active')
        AND department_id IN (SELECT id FROM departments WHERE active = 1)
        AND role_id IN (SELECT id FROM roles WHERE level > 5)
        AND group_id IN (SELECT id FROM groups WHERE public = 1);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'TOO_MANY_SUBQUERIES')).toBe(true);
      expect(result.metrics.subqueryCount).toBe(4);
    });

    it('should warn about ORDER BY without LIMIT', () => {
      const sql = 'SELECT id, name FROM users ORDER BY created_at DESC;';
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'ORDER_BY_NO_LIMIT')).toBe(true);
    });

    it('should NOT warn about ORDER BY with LIMIT', () => {
      const sql = 'SELECT id, name FROM users ORDER BY created_at DESC LIMIT 10;';
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'ORDER_BY_NO_LIMIT')).toBe(false);
    });
  });

  describe('checkPerformanceIssues() - Complex INSERT', () => {
    it('should warn about INSERT with too many columns', () => {
      const columns = Array(25).fill(0).map((_, i) => `col${i}`).join(', ');
      const values = Array(25).fill("'value'").join(', ');
      const sql = `INSERT INTO large_table (${columns}) VALUES (${values});`;
      
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'COMPLEX_INSERT')).toBe(true);
      expect(result.metrics.maxInsertColumns).toBe(25);
    });

    it('should NOT warn for normal INSERT', () => {
      const sql = "INSERT INTO users (name, email, age) VALUES ('John', 'john@example.com', 30);";
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.warnings.some(w => w.code === 'COMPLEX_INSERT')).toBe(false);
    });
  });

  describe('validateContent() integration with performance checks', () => {
    it('should include performance warnings in validation result', () => {
      const content = `-- +migrate Up
CREATE INDEX idx1 ON users (name);
CREATE INDEX idx2 ON users (email);
CREATE INDEX idx3 ON users (phone);
SELECT * FROM users;

-- +migrate Down
DROP INDEX idx1 ON users;
DROP INDEX idx2 ON users;
DROP INDEX idx3 ON users;
`;
      const result = adapter.validateContent(content, 'test.sql');
      
      expect(result.performanceIssues).toBeDefined();
      expect(result.performanceIssues.length).toBeGreaterThan(0);
      expect(result.performanceMetrics).toBeDefined();
      expect(result.summary.performanceIssues).toBeGreaterThan(0);
    });

    it('should have performance metrics even with no warnings', () => {
      const content = `-- +migrate Up
CREATE TABLE users (id INT PRIMARY KEY);

-- +migrate Down
DROP TABLE users;
`;
      const result = adapter.validateContent(content, 'test.sql');
      
      expect(result.performanceIssues).toBeDefined();
      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics.totalLength).toBeGreaterThan(0);
    });

    it('should still be valid with only performance warnings', () => {
      const content = `-- +migrate Up
SELECT * FROM users;

-- +migrate Down
SELECT 1;
`;
      const result = adapter.validateContent(content, 'test.sql');
      
      // Should be valid - performance issues are warnings, not errors
      expect(result.valid).toBe(true);
      expect(result.performanceIssues.some(w => w.code === 'SELECT_STAR')).toBe(true);
    });
  });

  describe('Performance check summary', () => {
    it('should identify critical performance issues', () => {
      const sql = `
        CREATE INDEX idx1 ON users (a);
        CREATE INDEX idx2 ON users (b);
        CREATE INDEX idx3 ON users (c);
        CREATE INDEX idx4 ON users (d);
        CREATE INDEX idx5 ON users (e);
        CREATE INDEX idx6 ON users (f);
      `;
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.summary.hasCriticalPerformanceIssues).toBe(true);
    });

    it('should not flag critical for minor warnings', () => {
      const sql = 'SELECT * FROM users;';
      const result = adapter.checkPerformanceIssues(sql);
      
      expect(result.summary.hasCriticalPerformanceIssues).toBe(false);
    });
  });
});