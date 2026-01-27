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
      db.createCollection('test');`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toBe(`db.dropDatabase(); db.createCollection('test');`);
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

    it('should NOT remove URL protocols', () => {
      const js = `const url = 'mongodb://localhost:27017';`;
      const normalized = adapter.normalizeJS(js);
      expect(normalized).toContain('mongodb://localhost:27017');
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
