/**
 * Gate R5 for MongoDB — ddlSafety.operationTimeoutMs
 */

import { describe, it, expect, vi } from 'vitest';
import { MongoOperationTimeoutError } from 'mongodb';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

function adapterWith(ddlSafety) {
  const adapter = new MongoDBAdapter({ mongodb: { databaseName: 'app' }, ddlSafety });
  adapter.db = { databaseName: 'app', marker: 'unbounded' };
  adapter.client = { db: vi.fn((name, opts) => ({ databaseName: name, opts })), close: vi.fn() };
  return adapter;
}

describe('MongoDB operation time limit (R5)', () => {
  it('is off by default: migrations get the adapter\'s own handles', async () => {
    const adapter = adapterWith(undefined);
    const fn = vi.fn();
    await adapter._runMigrationFunction(fn);
    expect(fn).toHaveBeenCalledWith(adapter.db, adapter.client);
  });

  it('passes timeoutMS on db and on client.db(), keeping other client methods working', async () => {
    const adapter = adapterWith({ operationTimeoutMs: 2000 });
    let seen;
    await adapter._runMigrationFunction(async (db, client) => {
      seen = { db, other: client.db('other'), close: client.close };
    });
    expect(seen.db).toEqual({ databaseName: 'app', opts: { timeoutMS: 2000 } });
    expect(seen.other).toEqual({ databaseName: 'other', opts: { timeoutMS: 2000 } });
    seen.close();
    expect(adapter.client.close).toHaveBeenCalled();
  });

  it('names the setting when an operation times out', async () => {
    const adapter = adapterWith({ operationTimeoutMs: 2000 });
    await expect(adapter._runMigrationFunction(async () => { throw new MongoOperationTimeoutError('Timed out during operation'); }))
      .rejects.toThrow(/^An operation ran longer than ddlSafety\.operationTimeoutMs \(2000 ms\)/);
    await expect(adapter._runMigrationFunction(async () => { throw Object.assign(new Error('operation exceeded time limit'), { code: 50 }); }))
      .rejects.toThrow(/operationTimeoutMs/);
  });

  it('passes other errors through unchanged', async () => {
    const adapter = adapterWith({ operationTimeoutMs: 2000 });
    await expect(adapter._runMigrationFunction(async () => { throw new Error('duplicate key'); })).rejects.toThrow(/^duplicate key$/);
  });

  it('rejects a value that is not a positive integer', () => {
    expect(() => adapterWith({ operationTimeoutMs: -5 }).getOperationTimeoutMs()).toThrow(/positive integer/);
    expect(() => adapterWith({ operationTimeoutMs: '2s' }).getOperationTimeoutMs()).toThrow(/positive integer/);
    expect(adapterWith({ operationTimeoutMs: 0 }).getOperationTimeoutMs()).toBeNull();
  });
});
