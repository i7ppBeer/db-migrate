/**
 * Gate R4 (MariaDB, advisory): ALTERs, index builds and bulk UPDATE/DELETE on
 * large tables among the migrations about to run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';

const migration = (up, down = 'SELECT 1;') => `-- +migrate Up\n${up}\n\n-- +migrate Down\n${down}\n`;

describe('MariaDB large-table check', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'large-table-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // sizes: { 'schema.table': rows } — bytes = rows × 100
  function adapterWith(sizes, config = {}) {
    const adapter = new MariaDBAdapter({ type: 'mariadb', database: 'app', migrationsDir: dir, ...config });
    adapter.connection = {
      query: vi.fn(async (sql, [schema, table]) => {
        const rows = sizes[`${schema}.${table}`];
        return [rows === undefined ? [] : [{ table_rows: rows, bytes: rows * 100 }]];
      })
    };
    return adapter;
  }

  it('finds ALTERs, index builds and bulk DML, qualified or quoted, and ignores the rest', () => {
    const ops = adapterWith({}).findHeavyStatements(`
      -- ALTER TABLE commented_out ADD c INT;
      ALTER ONLINE TABLE \`orders\` ADD COLUMN note VARCHAR(10);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_a ON orders (a);
      UPDATE LOW_PRIORITY archive.logs SET x = 1;
      DELETE FROM \`app\`.\`sessions\` WHERE expired = 1;
      OPTIMIZE TABLE events;
      INSERT INTO orders (a) VALUES (1);
      SELECT * FROM big;
    `);
    expect(ops).toEqual([
      { schema: null, table: 'orders', ops: ['ALTER TABLE', 'CREATE INDEX'] },
      { schema: 'archive', table: 'logs', ops: ['UPDATE'] },
      { schema: 'app', table: 'sessions', ops: ['DELETE'] },
      { schema: null, table: 'events', ops: ['OPTIMIZE TABLE'] }
    ]);
  });

  it('warns for a large table, with its size and what Lock Guard does not bound', async () => {
    await fs.writeFile(path.join(dir, '001-alter.sql'), migration('ALTER TABLE orders MODIFY COLUMN note TEXT;'));
    const r = await adapterWith({ 'app.orders': 25000000 }).largeTableWarnings(['001-alter.sql']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^001-alter\.sql: ALTER TABLE on 'orders' \(~25,000,000 rows, 2\.3 GB, over runtimeGates\.largeTableRows = 1,000,000\)/);
    expect(r.warnings[0]).toContain('Lock Guard bounds only the wait for its lock, not the run time');
  });

  it('looks the table up in its own schema and counts each table once', async () => {
    await fs.writeFile(path.join(dir, '001.sql'), migration('UPDATE archive.logs SET x = 1;'));
    await fs.writeFile(path.join(dir, '002.sql'), migration('DELETE FROM archive.logs WHERE x = 1;'));
    const adapter = adapterWith({ 'archive.logs': 3000000 });
    const r = await adapter.largeTableWarnings(['001.sql', '002.sql']);
    expect(r.warnings.map(w => w.split(' (')[0])).toEqual([
      "001.sql: UPDATE on 'archive.logs'",
      "002.sql: DELETE on 'archive.logs'"
    ]);
    expect(adapter.connection.query).toHaveBeenCalledTimes(1);
  });

  it('only looks at Up, and stays quiet below the threshold, when turned off, or for a table not created yet', async () => {
    await fs.writeFile(path.join(dir, '001.sql'), migration('ALTER TABLE orders ADD c INT;', 'ALTER TABLE big DROP c;'));
    await fs.writeFile(path.join(dir, '002.sql'), migration('ALTER TABLE brand_new ADD c INT;'));
    expect((await adapterWith({ 'app.orders': 999999, 'app.big': 9000000 }).largeTableWarnings(['001.sql'])).warnings).toEqual([]);
    expect((await adapterWith({ 'app.orders': 5000000 }, { runtimeGates: { largeTableRows: 0 } }).largeTableWarnings(['001.sql'])).warnings).toEqual([]);
    expect((await adapterWith({}).largeTableWarnings(['002.sql'])).warnings).toEqual([]);
  });

  it('names the statement time limit that will apply, and is silenced per file by @large-table-ok', async () => {
    await fs.writeFile(path.join(dir, '001.sql'), `-- @statement-timeout-sec: 900\n${migration('ALTER TABLE orders ADD c INT;')}`);
    await fs.writeFile(path.join(dir, '002.sql'), migration('ALTER TABLE orders ADD d INT;'));
    await fs.writeFile(path.join(dir, '003.sql'), `-- @large-table-ok: true\n${migration('ALTER TABLE orders ADD e INT;')}`);
    const sizes = { 'app.orders': 5000000 };
    const r = await adapterWith(sizes, { ddlSafety: { statementTimeoutSec: 60 } }).largeTableWarnings(['001.sql', '002.sql', '003.sql']);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('Each statement is stopped after 900 s (@statement-timeout-sec) and rolled back');
    expect(r.warnings[1]).toContain('Each statement is stopped after 60 s (ddlSafety.statementTimeoutSec)');
    const none = await adapterWith(sizes).largeTableWarnings(['002.sql']);
    expect(none.warnings[0]).toContain('No statement time limit applies');
  });

  it('reports a check that could not run as skipped instead of failing', async () => {
    const r = await adapterWith({}).largeTableWarnings(['missing.sql']);
    expect(r.warnings).toEqual([]);
    expect(r.skipped[0]).toMatch(/^R4 large-table check for missing\.sql:/);
  });
});
