/**
 * Tests for the sync-report helpers in src/core/reporter.js
 * (buildSyncReport / syncReportToHTML / saveSyncReport). The pre-existing
 * Reporter class (used by test-all) has no test coverage either way and is
 * out of scope here — this file only covers what was added for `sync -o`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildSyncReport, syncReportToHTML, saveSyncReport } from '../src/core/reporter.js';
import { diffSchemaSnapshots } from '../src/core/schema-diff.js';

describe('buildSyncReport', () => {
  it('fills in defaults for omitted optional fields', () => {
    const report = buildSyncReport({ dbType: 'mariadb', status: 'no-pending', durationMs: 12 });
    expect(report.dbType).toBe('mariadb');
    expect(report.database).toBeNull();
    expect(report.status).toBe('no-pending');
    expect(report.pending).toEqual([]);
    expect(report.applied).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.schema).toBeNull();
    expect(typeof report.generatedAt).toBe('string');
  });

  it('carries through all provided fields', () => {
    const schema = [{ table: 'users', engine: 'InnoDB', rows: 5, columns: [] }];
    const report = buildSyncReport({
      dbType: 'mariadb',
      database: 'mydb',
      status: 'applied',
      pending: ['a.sql', 'b.sql'],
      applied: ['a.sql'],
      errors: ['b.sql: boom'],
      durationMs: 1500,
      schema
    });
    expect(report.database).toBe('mydb');
    expect(report.pending).toEqual(['a.sql', 'b.sql']);
    expect(report.applied).toEqual(['a.sql']);
    expect(report.errors).toEqual(['b.sql: boom']);
    expect(report.schema).toBe(schema);
  });
});

describe('syncReportToHTML', () => {
  it('renders MariaDB-shaped schema (table/columns) without throwing and escapes content', () => {
    const report = buildSyncReport({
      dbType: 'mariadb',
      database: 'mydb',
      status: 'applied',
      applied: ['<script>alert(1)</script>.sql'],
      durationMs: 500,
      schema: [{
        table: 'users',
        engine: 'InnoDB',
        rows: 10,
        columns: [{ name: 'id', type: 'bigint(20)', nullable: false, key: 'PRI' }]
      }]
    });
    const html = syncReportToHTML(report);
    expect(html).toContain('users');
    expect(html).toContain('bigint(20)');
    expect(html).not.toContain('<script>alert(1)</script>.sql');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders MongoDB-shaped schema (collection/fields) without throwing', () => {
    const report = buildSyncReport({
      dbType: 'mongodb',
      status: 'applied',
      durationMs: 200,
      schema: [{ collection: 'users', count: 3, indexes: ['_id_'], fields: [{ name: 'email', type: 'string' }] }]
    });
    const html = syncReportToHTML(report);
    expect(html).toContain('users');
    expect(html).toContain('email');
    expect(html).toContain('string');
  });

  it('renders a failed report with errors and no schema section', () => {
    const report = buildSyncReport({
      dbType: 'mariadb',
      status: 'failed',
      errors: ['20260101-broken.sql: syntax error'],
      applied: [],
      durationMs: 50
    });
    const html = syncReportToHTML(report);
    expect(html).toContain('FAILED');
    expect(html).toContain('syntax error');
    expect(html).not.toContain('Current Schema');
  });

  it('renders a no-pending report distinctly from applied/failed', () => {
    const report = buildSyncReport({ dbType: 'mariadb', status: 'no-pending', durationMs: 10 });
    const html = syncReportToHTML(report);
    expect(html).toContain('NO PENDING');
    expect(html).toContain('already up to date');
  });

  it('renders an added table, a removed table, and a changed column in the diff section', () => {
    const before = [
      { table: 'legacy', engine: 'InnoDB', rows: 0, columns: [] },
      { table: 'users', engine: 'InnoDB', rows: 5, columns: [{ name: 'email', type: 'varchar(255)', nullable: false, key: '' }] }
    ];
    const after = [
      { table: 'users', engine: 'InnoDB', rows: 5, columns: [{ name: 'email', type: 'varchar(320)', nullable: false, key: '' }] },
      { table: 'orders', engine: 'InnoDB', rows: 0, columns: [] }
    ];
    const report = buildSyncReport({
      dbType: 'mariadb', status: 'applied', applied: ['x.sql'], durationMs: 1,
      schema: after, schemaDiff: diffSchemaSnapshots(before, after)
    });
    const html = syncReportToHTML(report);
    expect(html).toContain('Schema Changes');
    expect(html).toContain('orders');   // added
    expect(html).toContain('legacy');   // removed
    expect(html).toContain('varchar(255)');
    expect(html).toContain('varchar(320)');
  });

  it('renders "(schema unchanged)" when the diff is empty', () => {
    const same = [{ table: 'users', engine: 'InnoDB', rows: 0, columns: [{ name: 'id', type: 'bigint' }] }];
    const report = buildSyncReport({
      dbType: 'mariadb', status: 'applied', durationMs: 1,
      schema: same, schemaDiff: diffSchemaSnapshots(same, structuredClone(same))
    });
    const html = syncReportToHTML(report);
    expect(html).toContain('schema unchanged');
  });

  it('omits the Schema Changes card entirely when no diff was computed (e.g. adapter has no getSchemaSnapshot)', () => {
    const report = buildSyncReport({ dbType: 'mariadb', status: 'applied', durationMs: 1 });
    const html = syncReportToHTML(report);
    expect(html).not.toContain('Schema Changes');
  });
});

describe('saveSyncReport', () => {
  let tmpDir;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-sync-report-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes both json and html by default', async () => {
    const report = buildSyncReport({ dbType: 'mariadb', status: 'applied', applied: ['a.sql'], durationMs: 1 });
    const files = await saveSyncReport(tmpDir, report);
    expect(files).toHaveLength(2);
    expect(files.some(f => f.endsWith('.json'))).toBe(true);
    expect(files.some(f => f.endsWith('.html'))).toBe(true);

    const jsonFile = files.find(f => f.endsWith('.json'));
    const parsed = JSON.parse(await fs.readFile(jsonFile, 'utf-8'));
    expect(parsed.status).toBe('applied');
    expect(parsed.applied).toEqual(['a.sql']);
  });

  it('respects format: "json" and writes only one file', async () => {
    const report = buildSyncReport({ dbType: 'mariadb', status: 'no-pending', durationMs: 1 });
    const files = await saveSyncReport(tmpDir, report, 'json');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('creates the output directory if it does not exist yet', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    const report = buildSyncReport({ dbType: 'mariadb', status: 'no-pending', durationMs: 1 });
    const files = await saveSyncReport(nested, report, 'json');
    expect(files[0]).toContain(nested);
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });
});
