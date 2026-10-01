/**
 * Detection accuracy of the dangerous-operation rules — each case here was a
 * false positive or false negative found in review — plus the cross-file /
 * config-driven handling of dropped tables and collections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

const maria = new MariaDBAdapter({ type: 'mariadb', mode: 'versioned' });
const mariaCodes = (up, down = 'SELECT 1;') =>
  maria.validateContent(`-- +migrate Up\n${up}\n-- +migrate Down\n${down}\n`, 'f.sql').errors.map(e => e.code || e.type);
const mariaWarnings = (up, down = 'SELECT 1;') =>
  maria.validateContent(`-- +migrate Up\n${up}\n-- +migrate Down\n${down}\n`, 'f.sql').warnings.map(w => w.message);

describe('MariaDB dangerous-operation detection (per statement)', () => {
  it.each([
    ['UPDATE without WHERE, even if a later statement has one', 'UPDATE users SET a = 1;\nDELETE FROM logs WHERE id < 5;', 'UPDATE_ALL'],
    ['multi-table UPDATE … JOIN without WHERE', 'UPDATE t JOIN u ON u.id = t.uid SET t.a = u.a;', 'UPDATE_ALL'],
    ['DELETE without WHERE on a schema-qualified table', 'DELETE FROM app.logs;', 'DELETE_ALL'],
    ['DELETE without WHERE, backticked table', 'DELETE FROM `logs`;', 'DELETE_ALL'],
    ['multi-table DELETE alias form', 'DELETE l FROM logs l;', 'DELETE_ALL'],
    ['TRUNCATE without the TABLE keyword', 'TRUNCATE logs;', 'TRUNCATE_TABLE'],
    ['DROP COLUMN', 'ALTER TABLE users DROP COLUMN nickname;', 'DROP_COLUMN'],
    ['DROP column without the COLUMN keyword', 'ALTER TABLE users DROP nickname;', 'DROP_COLUMN'],
    ['DROP COLUMN on a schema-qualified table', 'ALTER TABLE app.users DROP COLUMN nickname;', 'DROP_COLUMN'],
    ['DROP COLUMN as the second clause of an ALTER', 'ALTER TABLE t ADD COLUMN a INT, DROP COLUMN b;', 'DROP_COLUMN']
  ])('flags %s', (_, up, code) => {
    expect(mariaCodes(up)).toContain(code);
  });

  it.each([
    ['UPDATE … WHERE as the last statement', 'UPDATE users SET a = 1 WHERE id = 1;', 'UPDATE_ALL'],
    ['UPDATE with a subquery WHERE', 'UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u);', 'UPDATE_ALL'],
    ['INSERT … ON DUPLICATE KEY UPDATE', 'INSERT INTO t (id, a) VALUES (1, 2) ON DUPLICATE KEY UPDATE a = 2;', 'UPDATE_ALL'],
    ['DELETE … WHERE on a schema-qualified table', 'DELETE FROM app.t WHERE created_at < NOW();', 'DELETE_ALL'],
    ['trigger body SET NEW.x', 'CREATE TRIGGER trg BEFORE UPDATE ON t FOR EACH ROW SET NEW.updated_at = NOW();', 'UPDATE_ALL'],
    ['DROP INDEX (not a column)', 'ALTER TABLE t DROP INDEX idx_a;', 'DROP_COLUMN'],
    ['DROP FOREIGN KEY (not a column)', 'ALTER TABLE t DROP FOREIGN KEY fk_a;', 'DROP_COLUMN'],
    ['DROP PRIMARY KEY (not a column)', 'ALTER TABLE t DROP PRIMARY KEY;', 'DROP_COLUMN'],
    ['ADD column + DROP INDEX in one ALTER', 'ALTER TABLE t ADD COLUMN a INT, DROP INDEX idx_b;', 'DROP_COLUMN'],
    ['DROP DATABASE mentioned inside a string literal', "INSERT INTO audit(note) VALUES ('ran DROP DATABASE drill');", 'DROP_DATABASE']
  ])('does not flag %s', (_, up, code) => {
    expect(mariaCodes(up)).not.toContain(code);
  });

  it('DATETIME precision warning only for the DATETIME type, not column names containing it', () => {
    expect(mariaWarnings('ALTER TABLE t ADD COLUMN created_datetime DATETIME(3);', 'ALTER TABLE t DROP COLUMN created_datetime;')
      .some(m => /DATETIME without precision/.test(m))).toBe(false);
    expect(mariaWarnings('ALTER TABLE t ADD COLUMN seen_at DATETIME NULL;', 'ALTER TABLE t DROP COLUMN seen_at;')
      .some(m => /DATETIME without precision/.test(m))).toBe(true);
  });

  it('NOT NULL-without-DEFAULT warning wherever DEFAULT is placed', () => {
    const warns = (up) => mariaWarnings(up, 'ALTER TABLE t DROP COLUMN q;').some(m => /NOT NULL column should have DEFAULT/.test(m));
    expect(warns('ALTER TABLE t ADD COLUMN q INT NOT NULL;')).toBe(true);
    expect(warns('ALTER TABLE t ADD COLUMN q INT NOT NULL DEFAULT 0;')).toBe(false);
    expect(warns('ALTER TABLE t ADD COLUMN q INT DEFAULT 0 NOT NULL;')).toBe(false);
  });
});

describe('MongoDB dangerous-operation detection', () => {
  const mongo = new MongoDBAdapter({ type: 'mongodb', mode: 'versioned', mongodb: {} });
  const codes = (up, down = "await db.collection('x').findOne({});") =>
    mongo.validateContent(`export async function up(db) {\n${up}\n}\nexport async function down(db) {\n${down}\n}\n`, 'f.js').errors.map(e => e.code || e.type);

  it.each([
    ['db.dropCollection()', "await db.dropCollection('orders');", 'DROP_COLLECTION'],
    ['deleteMany() with no filter', "await db.collection('o').deleteMany();", 'DELETE_ALL'],
    ['deleteMany({}) across lines', "await db.collection('o').deleteMany(\n  {}\n);", 'DELETE_ALL'],
    ['deleteMany({}, options)', "await db.collection('o').deleteMany({}, { session });", 'DELETE_ALL'],
    ['bulkWrite deleteMany with an empty filter', "await db.collection('o').bulkWrite([{ deleteMany: { filter: {} } }]);", 'DELETE_ALL'],
    ['bulkWrite updateMany with an empty filter', "await db.collection('o').bulkWrite([{ updateMany: { filter: {}, update: { $set: { a: 1 } } } }]);", 'UPDATE_ALL']
  ])('flags %s', (_, up, code) => {
    expect(codes(up)).toContain(code);
  });

  it('does not flag deleteMany with a filter', () => {
    expect(codes("await db.collection('o').deleteMany({ status: 'old' });")).not.toContain('DELETE_ALL');
  });
});

describe('drops of tables/collections created by earlier files (validate())', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-rules-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const write = (name, content) => fs.writeFile(path.join(dir, name), content, 'utf-8');
  const fileResult = (result, file) => result.results.find(r => r.file === file);

  it('MariaDB: dropping a known table is DROP_TABLE (data loss); an unknown one is ORPHAN_DROP_UP (likely a typo)', async () => {
    await write('20260101000001-create.sql', '-- +migrate Up\nCREATE TABLE legacy_orders (id INT);\n-- +migrate Down\nDROP TABLE legacy_orders;\n');
    await write('20260101000002-drop.sql', '-- +migrate Up\nDROP TABLE legacy_orders;\n-- +migrate Down\nSELECT 1;\n');
    await write('20260101000003-typo.sql', '-- +migrate Up\nDROP TABLE legacy_ordrs;\n-- +migrate Down\nSELECT 1;\n');
    const result = await new MariaDBAdapter({ type: 'mariadb', mode: 'versioned', migrationsDir: dir }).validate();

    const drop = fileResult(result, '20260101000002-drop.sql');
    expect(drop.errors.map(e => e.code)).toEqual(['DROP_TABLE']);
    expect(drop.errors[0].message).toContain('created by 20260101000001-create.sql');
    const typo = fileResult(result, '20260101000003-typo.sql');
    expect(typo.errors.map(e => e.code)).toEqual(['ORPHAN_DROP_UP']);
    expect(typo.errors[0].message).toMatch(/check the name/);
  });

  it('MariaDB: validation.existingTables covers pre-existing tables for DROP and FK checks', async () => {
    await write('20260101000001-child.sql', '-- +migrate Up\nCREATE TABLE child (id INT, p INT, FOREIGN KEY (p) REFERENCES legacy_parent(id));\n-- +migrate Down\nDROP TABLE child;\n');
    await write('20260101000002-drop.sql', '-- +migrate Up\nDROP TABLE legacy_tmp;\n-- +migrate Down\nSELECT 1;\n');
    const adapter = new MariaDBAdapter({
      type: 'mariadb', mode: 'versioned', migrationsDir: dir,
      validation: { existingTables: ['legacy_parent', 'Legacy_Tmp'] }
    });
    const result = await adapter.validate();

    expect(fileResult(result, '20260101000001-child.sql').valid).toBe(true);
    const drop = fileResult(result, '20260101000002-drop.sql');
    expect(drop.errors.map(e => e.code)).toEqual(['DROP_TABLE']);
    expect(drop.errors[0].message).toContain('validation.existingTables');
  });

  it('MariaDB: validation.allow approves per file from config, and flags entries for missing files', async () => {
    await write('20260101000001-create.sql', '-- +migrate Up\nCREATE TABLE t (id INT);\n-- +migrate Down\nDROP TABLE t;\n');
    await write('20260101000002-drop.sql', '-- +migrate Up\nDROP TABLE t;\n-- +migrate Down\nSELECT 1;\n');
    const adapter = new MariaDBAdapter({
      type: 'mariadb', mode: 'versioned', migrationsDir: dir,
      validation: { allow: { '20260101000002-drop.sql': ['DROP_TABLE'], '20260101000099-gone.sql': ['DROP_TABLE'] } }
    });
    const result = await adapter.validate();

    const drop = fileResult(result, '20260101000002-drop.sql');
    expect(drop.valid).toBe(true);
    expect(drop.warnings.some(w => w.type === 'dangerous-allowed' && w.code === 'DROP_TABLE')).toBe(true);
    expect(result.configWarnings).toEqual([expect.stringContaining("'20260101000099-gone.sql'")]);
  });

  it('MongoDB: dropping a known collection is DROP_COLLECTION only; an unknown one is also ORPHAN_DROP_UP', async () => {
    await write('20260101000001-create.js', "export async function up(db) { await db.createCollection('old'); }\nexport async function down(db) { await db.collection('old').drop(); }\n");
    await write('20260101000002-drop.js', "export async function up(db) { await db.collection('old').drop(); }\nexport async function down(db) { await db.collection('x').findOne({}); }\n");
    await write('20260101000003-typo.js', "export async function up(db) { await db.dropCollection('olld'); }\nexport async function down(db) { await db.collection('x').findOne({}); }\n");
    const result = await new MongoDBAdapter({ type: 'mongodb', migrationsDir: dir, mongodb: {} }).validate();

    expect(fileResult(result, '20260101000002-drop.js').errors.map(e => e.code)).toEqual(['DROP_COLLECTION']);
    expect(fileResult(result, '20260101000003-typo.js').errors.map(e => e.code).sort()).toEqual(['DROP_COLLECTION', 'ORPHAN_DROP_UP']);
  });
});
