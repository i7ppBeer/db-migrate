/**
 * Tests for the pre-run validation gate (src/core/validation-gate.js) and the
 * pieces it relies on: which files a versioned project considers migrations
 * (R__ excluded), which of them a run will execute (--target / --only), and
 * validate() restricted to those files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { selectPendingMigrations, isRepeatableMigrationFile } from '../src/core/base-adapter.js';
import { checkMigrationsToRun, allowHintForFailures, describeValidationFailures, validationOptionsFromCli } from '../src/core/validation-gate.js';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

describe('selectPendingMigrations', () => {
  const pending = ['20260101-a.sql', '20260102-b1.sql', '20260103-b.sql', '20260104-c.sql'];

  it('returns everything without --target / --only', () => {
    expect(selectPendingMigrations(pending)).toEqual({ selected: pending, error: null });
  });

  it('--target prefers an exact name over a substring match', () => {
    expect(selectPendingMigrations(pending, { target: '20260103-b' }).selected)
      .toEqual(['20260101-a.sql', '20260102-b1.sql', '20260103-b.sql']);
  });

  it('--only picks a single migration, within --target if both are given', () => {
    expect(selectPendingMigrations(pending, { only: 'c' }).selected).toEqual(['20260104-c.sql']);
    expect(selectPendingMigrations(pending, { target: 'b1', only: 'c' }).error).toMatch(/not found in pending/);
  });

  it('reports a target that matches nothing', () => {
    expect(selectPendingMigrations(pending, { target: 'zzz' })).toEqual({ selected: [], error: 'Target migration not found: zzz' });
  });
});

describe('isRepeatableMigrationFile', () => {
  it('matches R__ files by base name only', () => {
    expect(isRepeatableMigrationFile('R__001_users.sql')).toBe(true);
    expect(isRepeatableMigrationFile('/x/migrations/R__001_users.js')).toBe(true);
    expect(isRepeatableMigrationFile('20260101-R__not.sql')).toBe(false);
  });
});

describe('checkMigrationsToRun', () => {
  // Minimal adapter stub: records what it was asked to validate.
  function adapterReturning(results) {
    const calls = [];
    return {
      calls,
      validate: async (opts) => {
        calls.push(opts);
        return { valid: results.every(r => r.valid), results };
      }
    };
  }

  it('validates exactly the migrations the run will execute', async () => {
    const adapter = adapterReturning([]);
    await checkMigrationsToRun(adapter, ['a.sql', 'b.sql', 'c.sql'], { target: 'b' });
    expect(adapter.calls[0].files).toEqual(['a.sql', 'b.sql']);
  });

  it('does not call validate() when nothing will run', async () => {
    const adapter = adapterReturning([]);
    const gate = await checkMigrationsToRun(adapter, [], {});
    expect(gate.files).toEqual([]);
    expect(adapter.calls).toHaveLength(0);
  });

  it('separates overridable codes from ones that need the file fixed', async () => {
    const adapter = adapterReturning([{
      file: 'a.sql',
      valid: false,
      errors: [
        { code: 'TRUNCATE_TABLE', message: 'truncate' },
        { code: 'MISSING_UP_MARKER', type: 'missing-up-marker', message: 'no up' },
        { code: 'ORPHAN_DROP_UP', type: 'orphan-drop-in-up', message: 'orphan' }
      ],
      dangerousOps: [{ code: 'TRUNCATE_TABLE' }],
      forbiddenOps: [],
      warnings: []
    }]);
    const gate = await checkMigrationsToRun(adapter, ['a.sql'], {});
    expect(gate.failures[0].allowable).toEqual(['TRUNCATE_TABLE', 'ORPHAN_DROP_UP']);
    expect(gate.failures[0].mustFix).toEqual(['MISSING_UP_MARKER']);
    expect(allowHintForFailures(gate.failures)).toEqual({ allow: 'TRUNCATE_TABLE,ORPHAN_DROP_UP', needsFix: true });
    expect(describeValidationFailures(gate.failures)).toEqual(['a.sql: TRUNCATE_TABLE, MISSING_UP_MARKER, ORPHAN_DROP_UP']);
  });

  it('DDL inside a DCL file is never offered as overridable', async () => {
    const adapter = adapterReturning([{
      file: 'R__1.sql', valid: false,
      errors: [{ code: 'CREATE_TABLE_IN_DCL', message: 'ddl' }],
      forbiddenOps: [{ code: 'CREATE_TABLE_IN_DCL', type: 'forbidden-dclReverse' }],
      dangerousOps: [], warnings: []
    }]);
    const gate = await checkMigrationsToRun(adapter, ['R__1.sql'], {});
    expect(allowHintForFailures(gate.failures)).toEqual({ allow: '', needsFix: true });
  });

  it('reports every allowance that was used, for the run log', async () => {
    const adapter = adapterReturning([{
      file: 'a.sql', valid: true, errors: [],
      warnings: [
        { type: 'dangerous-allowed', code: 'TRUNCATE_TABLE', message: '✅ [ALLOWED] truncate' },
        { type: 'warning', message: 'just advice' }
      ]
    }]);
    const gate = await checkMigrationsToRun(adapter, ['a.sql'], { allow: ['truncate_table'] });
    expect(adapter.calls[0].allowedCodes).toEqual(['TRUNCATE_TABLE']);
    expect(gate.allowed).toEqual([{ file: 'a.sql', code: 'TRUNCATE_TABLE', message: '✅ [ALLOWED] truncate' }]);
  });

  it('turns a validate() that could not run into an error', async () => {
    const adapter = { validate: async () => ({ valid: false, results: [], error: 'ENOENT: no such directory' }) };
    const gate = await checkMigrationsToRun(adapter, ['a.sql'], {});
    expect(gate.error).toMatch(/validation could not run: ENOENT/);
  });

  it('maps CLI flags to validate options', () => {
    expect(validationOptionsFromCli({ allowDangerous: true, allow: [' drop_column ', ''] }))
      .toEqual({ allowDangerous: true, allowForbidden: false, allowedCodes: ['DROP_COLUMN'] });
  });
});

describe('validate() on a versioned directory', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-gate-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const write = (name, content) => fs.writeFile(path.join(dir, name), content, 'utf-8');

  it('MariaDB: skips R__ files, rejects a file without an Up marker, and can be limited to given files', async () => {
    await write('20260101000001-create.sql', '-- +migrate Up\nCREATE TABLE a (id INT PRIMARY KEY);\n-- +migrate Down\nDROP TABLE a;\n');
    await write('20260101000002-no-marker.sql', 'CREATE TABLE b (id INT);\n');
    await write('20260101000003-child.sql', '-- +migrate Up\nCREATE TABLE c (id INT, a_id INT, FOREIGN KEY (a_id) REFERENCES a(id));\n-- +migrate Down\nDROP TABLE c;\n');
    await write('R__010_users.sql', "CREATE USER 'x'@'%';\n");
    const adapter = new MariaDBAdapter({ type: 'mariadb', mode: 'versioned', migrationsDir: dir });

    const all = await adapter.validate();
    expect(all.results.map(r => r.file)).toEqual(['20260101000001-create.sql', '20260101000002-no-marker.sql', '20260101000003-child.sql']);
    expect(all.ignoredRepeatableFiles).toEqual(['R__010_users.sql']);
    expect(all.results[1].errors.map(e => e.code)).toContain('MISSING_UP_MARKER');

    // Only the pending file is reported — but the FK check still knows table
    // `a` was created by the (already applied) first file.
    const pendingOnly = await adapter.validate({ files: ['20260101000003-child.sql'] });
    expect(pendingOnly.results.map(r => r.file)).toEqual(['20260101000003-child.sql']);
    expect(pendingOnly.results[0].valid).toBe(true);
    expect(pendingOnly.skippedFiles).toEqual(['20260101000001-create.sql', '20260101000002-no-marker.sql']);
  });

  it('MongoDB: skips R__ files in a versioned directory', async () => {
    await write('20260101000001-a.js', "export async function up(db) { await db.createCollection('a'); }\nexport async function down(db) { await db.collection('a').drop(); }\n");
    await write('R__010_users.js', 'export async function up(db, client) {}\n');
    const adapter = new MongoDBAdapter({ type: 'mongodb', migrationsDir: dir, mongodb: {} });

    const result = await adapter.validate();
    expect(result.results.map(r => r.file)).toEqual(['20260101000001-a.js']);
    expect(result.ignoredRepeatableFiles).toEqual(['R__010_users.js']);
    expect(await adapter.getMigrationFiles()).toEqual(['20260101000001-a.js']);
  });
});

describe('rollbackPlan()', () => {
  // status() stub: applied in file order, as the adapter reports them
  const withApplied = (adapter, applied, mismatches = []) => {
    adapter.status = async () => ({ applied: applied.map(f => ({ fileName: f, appliedAt: new Date() })), checksumMismatches: mismatches.map(f => ({ fileName: f })) });
    return adapter;
  };

  it('MariaDB: last N, most recent first', async () => {
    const a = withApplied(new MariaDBAdapter({ type: 'mariadb' }), ['1-a.sql', '2-b.sql', '3-c.sql']);
    expect((await a.rollbackPlan({ count: 2 })).files).toEqual(['3-c.sql', '2-b.sql']);
  });

  it('MariaDB: --target rolls back everything after it and the target itself', async () => {
    const a = withApplied(new MariaDBAdapter({ type: 'mariadb' }), ['1-a.sql', '2-b.sql', '3-c.sql'], ['2-b.sql']);
    const plan = await a.rollbackPlan({ count: 1, target: '2-b' });
    expect(plan.files).toEqual(['3-c.sql', '2-b.sql']);
    expect(plan.checksumMismatches).toEqual(['2-b.sql']);
    expect((await a.rollbackPlan({ target: 'zzz' })).error).toMatch(/not found/);
  });
});

describe('fixture expectations (@expect-error)', async () => {
  const { parseExpectedErrors, checkFileExpectation } = await import('../src/core/fixture-expectations.js');

  it('parses the annotation from SQL or JS, normalized and sorted', () => {
    expect(parseExpectedErrors('-- @expect-error: truncate_table, DROP_DATABASE\n-- +migrate Up\n')).toEqual(['DROP_DATABASE', 'TRUNCATE_TABLE']);
    expect(parseExpectedErrors('// @expect-error: DELETE_ALL\nexport async function up() {}')).toEqual(['DELETE_ALL']);
    expect(parseExpectedErrors('-- +migrate Up\nSELECT 1;')).toBeNull();
  });

  const result = (valid, codes) => ({ valid, errors: codes.map(code => ({ code })) });

  it('passes only on exactly the declared codes', () => {
    expect(checkFileExpectation(result(false, ['TRUNCATE_TABLE']), ['TRUNCATE_TABLE']).ok).toBe(true);
    expect(checkFileExpectation(result(false, ['GRANT']), ['TRUNCATE_TABLE']).message).toBe('missing expected TRUNCATE_TABLE; unexpected GRANT');
    expect(checkFileExpectation(result(true, []), ['TRUNCATE_TABLE']).message).toMatch(/but it passed validation/);
  });

  it('a file without the annotation must be valid', () => {
    expect(checkFileExpectation(result(true, []), null).ok).toBe(true);
    expect(checkFileExpectation(result(false, ['DROP_COLUMN']), null).message).toBe('expected to be valid, but failed with DROP_COLUMN');
  });
});
