/**
 * Gate R5 (MariaDB, opt-in): statement time limit via max_statement_time —
 * ddlSafety.statementTimeoutSec, or "-- @statement-timeout-sec: N" per file.
 * Verified against MariaDB 11.8: a COPY ALTER and an UPDATE are stopped with
 * errno 1969, an in-place ALTER with 1317; each is rolled back.
 */

import { describe, it, expect, vi } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';

const migration = (up, header = '') => `${header}-- +migrate Up\n${up}\n\n-- +migrate Down\nSELECT 1;\n`;

function adapterWith(config = {}, failOn = null) {
  const adapter = new MariaDBAdapter({ type: 'mariadb', database: 'app', ...config });
  adapter.connection = {
    query: vi.fn(async (sql) => {
      if (/@@session\.max_statement_time/.test(sql)) return [[{ previous: 0 }]];
      if (failOn && failOn.pattern.test(sql)) throw failOn.error;
      return [[]];
    })
  };
  return adapter;
}
const sqlCalls = (adapter) => adapter.connection.query.mock.calls.map(([sql]) => sql);

describe('MariaDB statement time limit', () => {
  it('resolves the file annotation over the config, 0 meaning no limit for that file', () => {
    const adapter = adapterWith({ ddlSafety: { statementTimeoutSec: 60 } });
    expect(adapter.resolveStatementTimeout(migration('SELECT 1;'))).toEqual({ timeoutSec: 60, timeoutSource: 'ddlSafety.statementTimeoutSec' });
    expect(adapter.resolveStatementTimeout(migration('SELECT 1;', '-- @statement-timeout-sec: 900\n'))).toEqual({ timeoutSec: 900, timeoutSource: '@statement-timeout-sec' });
    expect(adapter.resolveStatementTimeout(migration('SELECT 1;', '-- @statement-timeout-sec: 0\n'))).toEqual({ timeoutSec: null, timeoutSource: '@statement-timeout-sec' });
    expect(adapterWith().resolveStatementTimeout(migration('SELECT 1;'))).toEqual({ timeoutSec: null, timeoutSource: 'ddlSafety.statementTimeoutSec' });
    expect(() => adapterWith({ ddlSafety: { statementTimeoutSec: 1.5 } }).resolveStatementTimeout('')).toThrow(/positive integer/);
  });

  it('refuses a malformed annotation in validation', () => {
    const r = adapterWith().validateContent(migration('ALTER TABLE t ADD c INT;', '-- @statement-timeout-sec: 10m\n'), '001.sql');
    expect(r.errors.map(e => e.code)).toContain('INVALID_STATEMENT_TIMEOUT');
  });

  it('sets max_statement_time around the migration and restores it', async () => {
    const adapter = adapterWith();
    await adapter.executeWithLockGuard('ALTER TABLE t ADD c INT', { database: 'app', timeoutSec: 30 });
    const calls = sqlCalls(adapter);
    expect(calls.indexOf('SET SESSION max_statement_time = 30')).toBeLessThan(calls.indexOf('ALTER TABLE t ADD c INT'));
    expect(calls.at(-1)).toBe('SET SESSION max_statement_time = 0');
  });

  it('says plainly that MySQL has no max_statement_time, before running anything', async () => {
    const error = Object.assign(new Error("Unknown system variable 'max_statement_time'"), { errno: 1193 });
    const adapter = adapterWith();
    adapter.connection.query.mockImplementation(async (sql) => { if (/max_statement_time/.test(sql)) throw error; return [[]]; });
    await expect(adapter.executeWithLockGuard('ALTER TABLE t ADD c INT', { timeoutSec: 30 }))
      .rejects.toThrow(/ddlSafety\.statementTimeoutSec needs MariaDB's max_statement_time.*nothing was run/);
    expect(sqlCalls(adapter)).not.toContain('ALTER TABLE t ADD c INT');
  });

  it('leaves max_statement_time alone without a limit', async () => {
    const adapter = adapterWith();
    await adapter.executeWithLockGuard('ALTER TABLE t ADD c INT', { database: 'app' });
    expect(sqlCalls(adapter).some(sql => /max_statement_time/.test(sql))).toBe(false);
  });

  it.each([1969, 1317])('explains errno %i, never retries it, and still restores the session', async (errno) => {
    const error = Object.assign(new Error('Query execution was interrupted'), { errno });
    const adapter = adapterWith({}, { pattern: /^UPDATE/, error });
    await expect(adapter.executeWithLockGuard('CREATE TABLE s (id INT);\nUPDATE big SET b = b + 1', { timeoutSec: 5, timeoutSource: '@statement-timeout-sec' }))
      .rejects.toThrow(/statement 2 of 2; statement 1 was already applied.*stopped by @statement-timeout-sec \(5 s\) or a KILL QUERY; the server rolled that statement back\. If this migration needs longer/);
    const calls = sqlCalls(adapter);
    expect(calls.filter(sql => /^UPDATE/.test(sql))).toHaveLength(1);
    expect(calls.at(-1)).toBe('SET SESSION max_statement_time = 0');
  });
});
