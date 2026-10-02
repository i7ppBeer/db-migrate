/**
 * Follow-ups to multi-directory DCL, MongoDB R5 and approver recording:
 * create-dcl --dir, per-file @operation-timeout-ms, approvals from DCL runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pickDir } from '../src/core/migration-dirs.js';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';
import { MongoOperationTimeoutError } from 'mongodb';

describe('create-dcl with several migration directories', () => {
  let root, shared, tw;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cdcl-'));
    shared = path.join(root, 'shared');
    tw = path.join(root, 'prod-tw');
    await fs.mkdir(shared);
    await fs.mkdir(tw);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('pickDir: one directory needs no --dir; a list needs one that matches', () => {
    expect(pickDir(shared)).toBe(shared);
    expect(() => pickDir([shared, tw])).toThrow(/lists 2 directories \(shared, prod-tw\) — .*--dir/);
    expect(pickDir([shared, tw], 'prod-tw')).toBe(tw);
    expect(pickDir([shared, tw], 'prod-tw/')).toBe(tw);
    expect(pickDir([shared, tw], tw)).toBe(tw);
    expect(() => pickDir([shared, tw], 'prod-jp')).toThrow(/not one of migrationsDir's directories \(shared, prod-tw\)/);
  });

  it('creates the file in the chosen directory', async () => {
    const adapter = new MariaDBAdapter({ mode: 'repeatable', migrationsDir: [shared, tw], mariadb: {} });
    const fileName = await adapter.createDCL('tw app', '002', { dir: 'prod-tw' });
    expect(fileName).toBe('R__002_tw_app.sql');
    await expect(fs.access(path.join(tw, fileName))).resolves.toBeUndefined();
    await expect(adapter.createDCL('x', '003')).rejects.toThrow(/--dir/);
  });

  it('refuses a name that already exists in another listed directory', async () => {
    await fs.writeFile(path.join(shared, 'R__001_report.js'), '');
    const adapter = new MongoDBAdapter({ mode: 'repeatable', migrationsDir: [shared, tw], mongodb: {} });
    await expect(adapter.createDCL('report', '001', { dir: 'prod-tw' }))
      .rejects.toThrow(`already exists: ${path.join(shared, 'R__001_report.js')}`);
  });
});

describe('MongoDB per-file @operation-timeout-ms', () => {
  function adapterWith(ddlSafety) {
    const adapter = new MongoDBAdapter({ mongodb: { databaseName: 'app' }, ddlSafety });
    adapter.db = { databaseName: 'app' };
    adapter.client = { db: vi.fn((name, opts) => ({ databaseName: name, opts })) };
    return adapter;
  }
  const file = (header) => `${header}export async function up(db) {}\nexport async function down(db) {}\n`;

  it('the file\'s annotation wins over the project setting; 0 means no limit for that file', () => {
    const adapter = adapterWith({ operationTimeoutMs: 2000 });
    expect(adapter.resolveOperationTimeout(file('// @operation-timeout-ms: 600000\n'))).toEqual({ timeoutMS: 600000, source: '@operation-timeout-ms' });
    expect(adapter.resolveOperationTimeout(file('// @operation-timeout-ms: 0\n')).timeoutMS).toBeNull();
    expect(adapter.resolveOperationTimeout(file(''))).toEqual({ timeoutMS: 2000, source: 'ddlSafety.operationTimeoutMs' });
    expect(adapterWith(undefined).resolveOperationTimeout(file('// @operation-timeout-ms: 5000\n')).timeoutMS).toBe(5000);
  });

  it('passes the file\'s limit to the migration\'s db handle', async () => {
    const adapter = adapterWith(undefined);
    let seen;
    await adapter._runMigrationFunction(async (db) => { seen = db; }, file('// @operation-timeout-ms: 5000\n'));
    expect(seen.opts).toEqual({ timeoutMS: 5000 });
  });

  it('a timeout message points at whichever setting applied, and how to give one file more time', async () => {
    const timeout = async () => { throw new MongoOperationTimeoutError('Timed out'); };
    await expect(adapterWith({ operationTimeoutMs: 2000 })._runMigrationFunction(timeout, file('')))
      .rejects.toThrow(/ddlSafety\.operationTimeoutMs \(2000 ms\).*"\/\/ @operation-timeout-ms: <ms>" at the top/);
    await expect(adapterWith(undefined)._runMigrationFunction(timeout, file('// @operation-timeout-ms: 300\n')))
      .rejects.toThrow(/@operation-timeout-ms \(300 ms\).*raise the value in its/);
  });

  it('an invalid annotation fails validation before anything runs', () => {
    const adapter = adapterWith(undefined);
    const r = adapter.validateContent(file('// @operation-timeout-ms: 10s\n'), 'a.js');
    expect(r.valid).toBe(false);
    expect(r.errors.map(e => e.code)).toContain('INVALID_OPERATION_TIMEOUT');
    expect(() => adapter.resolveOperationTimeout(file('// @operation-timeout-ms: 10s\n'))).toThrow(/whole number/);
  });
});

describe('DCL runs report released forbidden operations and their approver', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dclap-'));
    await fs.writeFile(path.join(dir, 'R__01_drop_old.sql'), "-- @allow-forbidden: true\n-- @approved-by: alice\nDROP USER IF EXISTS 'old'@'%';\n");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('runMariaDB collects approvals from the validator result', async () => {
    const runner = new RepeatableRunner({});
    const connection = {
      execute: vi.fn().mockResolvedValue([[]]),
      query: vi.fn(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ cnt: 0 }]] : [[]]))
    };
    const validator = {
      validateContent: vi.fn(() => ({ valid: true, errors: [], warnings: [], approval: { approvedBy: 'alice', codes: ['DROP_USER'] } }))
    };
    const result = await runner.run({ dbType: 'mariadb', connection, migrationsDir: dir, validator, approvedBy: 'bob' });
    expect(result.errors).toEqual([]);
    expect(result.approvals).toEqual([{ file: 'R__01_drop_old.sql', code: 'DROP_USER', approvedBy: 'alice' }]);
    expect(validator.validateContent.mock.calls[0][2].approvedBy).toBe('bob');
  });
});
