/**
 * Gate R4 (MongoDB, advisory): index builds / bulk writes on large collections
 * among the migrations about to run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

const migration = (up) => `export async function up(db, client) {\n${up}\n}\nexport async function down(db) {}\n`;

describe('MongoDB large-collection check', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'large-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function adapterWith(counts, config = {}) {
    const adapter = new MongoDBAdapter({ migrationsDir: dir, mongodb: { databaseName: 'app' }, ...config });
    const estimatedDocumentCount = vi.fn();
    adapter.db = {
      collection: (name) => ({ estimatedDocumentCount: () => { estimatedDocumentCount(name); return Promise.resolve(counts[name] ?? 0); } })
    };
    adapter.estimatedDocumentCount = estimatedDocumentCount;
    return adapter;
  }

  it('finds index builds and bulk writes, chained or through a variable, and ignores comments and cheap calls', () => {
    const adapter = adapterWith({});
    const ops = adapter.findHeavyOperations(migration(`
      await db.collection('orders')
        .createIndex({ customerId: 1 });
      const users = db.collection("users");
      await users.updateMany({}, { $set: { active: true } });
      await users.findOne({});
      await db.collection('logs').insertOne({});
      // await db.collection('archive').deleteMany({});
    `));
    expect(ops).toEqual([
      { collection: 'orders', ops: ['createIndex'] },
      { collection: 'users', ops: ['updateMany'] }
    ]);
  });

  it('warns for a large collection with no time limit, and says how to set one', async () => {
    await fs.writeFile(path.join(dir, '001-index.js'), migration(`await db.collection('orders').createIndex({ a: 1 });`));
    const r = await adapterWith({ orders: 2500000 }).largeCollectionWarnings(['001-index.js']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^001-index\.js: createIndex on 'orders' \(2,500,000 documents, over runtimeGates\.largeCollectionDocs = 1,000,000\)/);
    expect(r.warnings[0]).toContain('no operation time limit applies');
  });

  it('names the limit that will apply, from the file or the project', async () => {
    await fs.writeFile(path.join(dir, '001-a.js'), `// @operation-timeout-ms: 900000\n${migration(`await db.collection('orders').createIndex({ a: 1 });`)}`);
    await fs.writeFile(path.join(dir, '002-b.js'), migration(`await db.collection('orders').deleteMany({ old: true });`));
    const adapter = adapterWith({ orders: 5000000 }, { ddlSafety: { operationTimeoutMs: 60000 } });
    const r = await adapter.largeCollectionWarnings(['001-a.js', '002-b.js']);
    expect(r.warnings[0]).toContain('stopped after 900000 ms (@operation-timeout-ms)');
    expect(r.warnings[1]).toContain('stopped after 60000 ms (ddlSafety.operationTimeoutMs)');
    expect(adapter.estimatedDocumentCount).toHaveBeenCalledTimes(1); // counted once per collection
  });

  it('stays quiet below the threshold, when turned off, or with nothing heavy', async () => {
    await fs.writeFile(path.join(dir, '001.js'), migration(`await db.collection('orders').createIndex({ a: 1 });`));
    await fs.writeFile(path.join(dir, '002.js'), migration(`await db.collection('orders').insertOne({});`));
    expect((await adapterWith({ orders: 999999 }).largeCollectionWarnings(['001.js'])).warnings).toEqual([]);
    expect((await adapterWith({ orders: 5000000 }, { runtimeGates: { largeCollectionDocs: 0 } }).largeCollectionWarnings(['001.js'])).warnings).toEqual([]);
    expect((await adapterWith({ orders: 5000000 }).largeCollectionWarnings(['002.js'])).warnings).toEqual([]);
  });

  it('reports a check that could not run as skipped instead of failing', async () => {
    const r = await adapterWith({}).largeCollectionWarnings(['missing.js']);
    expect(r.warnings).toEqual([]);
    expect(r.skipped[0]).toMatch(/^R4 large-collection check for missing\.js:/);
  });
});
