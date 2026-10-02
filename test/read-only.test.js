/**
 * Read-only commands (status, up --dry-run, dcl:status, dcl --plan) must work
 * with a SELECT-only account: no CREATE/ALTER/UPDATE, no new tables.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';

const WRITE = /^\s*(CREATE|ALTER|UPDATE|INSERT|DELETE|DROP)\b/i;

function mariaConnection({ changelogColumns = null, rows = [] } = {}) {
  return {
    query: vi.fn().mockResolvedValue([[]]),
    execute: vi.fn((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) {
        return Promise.resolve([changelogColumns ? changelogColumns.map(name => ({ name })) : []]);
      }
      if (/^SELECT id/.test(sql)) return Promise.resolve([rows]);
      return Promise.resolve([[]]);
    })
  };
}

describe('read-only mode', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-'));
    await fs.writeFile(path.join(dir, '20260101000000-a.sql'), '-- +migrate Up\nCREATE TABLE a (id INT);\n-- +migrate Down\nDROP TABLE a;\n');
    await fs.writeFile(path.join(dir, '20260101000000-a.js'), 'export const up = async () => {}; export const down = async () => {};');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('MariaDB status() with no changelog table lists everything as pending and creates nothing', async () => {
    const adapter = new MariaDBAdapter({ migrationsDir: dir, mariadb: { database: 'app' } });
    adapter.readOnly = true;
    adapter.connection = mariaConnection();
    const status = await adapter.status();
    expect(status.pending).toEqual(['20260101000000-a.sql']);
    const sqls = adapter.connection.execute.mock.calls.map(([sql]) => sql);
    expect(sqls.filter(sql => WRITE.test(sql))).toEqual([]);
  });

  it('MariaDB status() leaves a row without a checksum alone instead of baselining it', async () => {
    const adapter = new MariaDBAdapter({ migrationsDir: dir, mariadb: { database: 'app' } });
    adapter.readOnly = true;
    adapter.connection = mariaConnection({
      changelogColumns: ['id', 'applied_at'], // pre-checksum table: no checksum column
      rows: [{ id: '20260101000000-a', applied_at: new Date(), checksum: null }]
    });
    const status = await adapter.status();
    expect(status.applied).toHaveLength(1);
    expect(status.checksumBaselined).toEqual([]);
    const sqls = adapter.connection.execute.mock.calls.map(([sql]) => sql);
    expect(sqls.some(sql => /NULL AS checksum/.test(sql))).toBe(true);
    expect(sqls.filter(sql => WRITE.test(sql))).toEqual([]);
  });

  it('MariaDB status() still baselines when not read-only', async () => {
    const adapter = new MariaDBAdapter({ migrationsDir: dir, mariadb: { database: 'app' } });
    adapter.connection = {
      query: vi.fn().mockResolvedValue([[]]),
      execute: vi.fn((sql) => {
        if (/information_schema\.SCHEMATA/.test(sql)) return Promise.resolve([[{ SCHEMA_NAME: 'app' }]]);
        if (/^SELECT id/.test(sql)) return Promise.resolve([[{ id: '20260101000000-a', applied_at: new Date(), checksum: null }]]);
        return Promise.resolve([[]]);
      })
    };
    const status = await adapter.status();
    expect(status.checksumBaselined).toEqual(['20260101000000-a.sql']);
  });

  it('MongoDB status() does not backfill missing checksums when read-only', async () => {
    const adapter = new MongoDBAdapter({ migrationsDir: dir, mongodb: { database: 'app' } });
    adapter.readOnly = true;
    const updateOne = vi.fn();
    adapter.db = {
      collection: () => ({
        find: () => ({ toArray: async () => [{ fileName: '20260101000000-a.js', appliedAt: new Date() }] }),
        updateOne
      })
    };
    const status = await adapter.status();
    expect(status.applied).toHaveLength(1);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('RepeatableRunner.status() reads checksums without creating the table', async () => {
    await fs.writeFile(path.join(dir, 'R__01_users.sql'), "CREATE USER IF NOT EXISTS 'a'@'%';");
    const runner = new RepeatableRunner({});
    const connection = mariaConnection();
    const status = await runner.status({ dbType: 'mariadb', connection, migrationsDir: dir });
    expect(status.pending.map(p => p.fileName)).toEqual(['R__01_users.sql']);
    const sqls = connection.execute.mock.calls.map(([sql]) => sql);
    expect(sqls.filter(sql => WRITE.test(sql))).toEqual([]);
  });

  it('RepeatableRunner.status() reads an existing checksum table, with or without the content column', async () => {
    const content = "CREATE USER IF NOT EXISTS 'a'@'%';";
    await fs.writeFile(path.join(dir, 'R__01_users.sql'), content);
    const runner = new RepeatableRunner({});
    const connection = mariaConnection({
      changelogColumns: ['id', 'checksum', 'applied_at'],
      rows: [{ id: 'R__01_users.sql', checksum: runner.calculateChecksum(content), applied_at: new Date() }]
    });
    const status = await runner.status({ dbType: 'mariadb', connection, migrationsDir: dir });
    expect(status.upToDate.map(u => u.fileName)).toEqual(['R__01_users.sql']);
    expect(connection.execute.mock.calls.some(([sql]) => /NULL AS content/.test(sql))).toBe(true);
  });
});
