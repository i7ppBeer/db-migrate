/**
 * addColumnIfMissing — MySQL-safe self-heal for the tool's bookkeeping tables
 */

import { describe, it, expect, vi } from 'vitest';
import { addColumnIfMissing } from '../src/core/sql-columns.js';

const spec = { table: '`app`.schema_migrations', tableName: 'schema_migrations', schema: 'app', column: 'checksum', definition: 'VARCHAR(64) NULL' };

function connection({ exists = false, alterError = null } = {}) {
  return {
    execute: vi.fn(async (sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) return [exists ? [{ 1: 1 }] : []];
      if (alterError) throw alterError;
      return [{}];
    })
  };
}

describe('addColumnIfMissing', () => {
  it('does nothing when the column is already there', async () => {
    const conn = connection({ exists: true });
    expect(await addColumnIfMissing(conn, spec)).toBe(false);
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(conn.execute.mock.calls[0][1]).toEqual(['app', 'schema_migrations', 'checksum']);
  });

  it('adds a missing column with plain ADD COLUMN — no MariaDB-only IF NOT EXISTS', async () => {
    const conn = connection();
    expect(await addColumnIfMissing(conn, spec)).toBe(true);
    const alter = conn.execute.mock.calls[1][0];
    expect(alter).toBe('ALTER TABLE `app`.schema_migrations ADD COLUMN checksum VARCHAR(64) NULL');
    expect(alter).not.toMatch(/IF\s+NOT\s+EXISTS/i);
  });

  it('tolerates a concurrent run adding the same column, but not other errors', async () => {
    await expect(addColumnIfMissing(connection({ alterError: Object.assign(new Error('dup'), { code: 'ER_DUP_FIELDNAME' }) }), spec)).resolves.toBe(false);
    await expect(addColumnIfMissing(connection({ alterError: Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) }), spec)).rejects.toThrow('denied');
  });

  it('falls back to the connection\'s current database when no schema is given', async () => {
    const conn = connection({ exists: true });
    await addColumnIfMissing(conn, { ...spec, schema: undefined });
    expect(conn.execute.mock.calls[0][0]).toContain('COALESCE(?, DATABASE())');
    expect(conn.execute.mock.calls[0][1][0]).toBeNull();
  });
});
