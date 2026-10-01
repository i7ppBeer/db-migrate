/**
 * Runtime gates R2–R4 (docs/RUNTIME-GATE-PLAN.md) — adapter-level checks with
 * mocked server responses. The real-database scenarios (an open transaction
 * plus a queued ALTER, a read-only server, a long MongoDB operation) were
 * verified against docker-compose's MariaDB/MongoDB; replica-set behavior
 * (secondary, lag) can only be exercised here.
 */

import { describe, it, expect, vi } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';

describe('MariaDB runtimePreflight()', () => {
  function adapterWith(handlers, config = {}) {
    const adapter = new MariaDBAdapter({ type: 'mariadb', database: 'app', ...config });
    adapter.connection = {
      query: vi.fn(async (sql) => {
        for (const [pattern, result] of handlers) {
          if (pattern.test(sql)) {
            if (result instanceof Error) throw result;
            return result;
          }
        }
        return [[]];
      })
    };
    return adapter;
  }
  const writable = [/@@global\.read_only/, [[{ ro: 0, iro: 0 }]]];

  it('R3: reports read_only even though the account could still write', async () => {
    const r = await adapterWith([[/@@global\.read_only/, [[{ ro: 1, iro: 0 }]]]]).runtimePreflight();
    expect(r.readOnly).toEqual({ reason: 'read_only = ON' });
  });

  it('R2: reports long-open transactions and metadata-lock waiters in this database', async () => {
    const adapter = adapterWith([
      writable,
      [/INNODB_TRX/, [[{ thread_id: 12, duration_sec: 300, user: 'batch', host: 'h', query: 'DELETE FROM orders' }]]],
      [/metadata lock/, [[{ id: 13, user: 'app', host: 'h', time_sec: 40, state: 'Waiting for table metadata lock', query: 'ALTER TABLE orders …' }]]]
    ], { runtimeGates: { longTransactionSec: 120 } });
    const r = await adapter.runtimePreflight();
    expect(r.openTransactions).toEqual([{ id: 'thread 12', durationSec: 300, who: 'batch@h', query: 'DELETE FROM orders' }]);
    expect(r.metadataLockWaits[0]).toMatchObject({ id: 'thread 13', state: 'Waiting for table metadata lock' });
    // threshold and database are passed to the query
    const trxCall = adapter.connection.query.mock.calls.find(([sql]) => /INNODB_TRX/.test(sql));
    expect(trxCall[1]).toEqual([120, 'app']);
  });

  it('R2/R4: checks that cannot run are reported as skipped, not failures', async () => {
    const r = await adapterWith([
      writable,
      [/INNODB_TRX/, new Error('Access denied; you need (at least one of) the PROCESS privilege(s)')],
      [/SHOW BINARY LOGS/, new Error('You are not using binary logging')]
    ]).runtimePreflight();
    expect(r.skipped).toEqual([
      expect.stringMatching(/^R2 open-transaction check \(needs the PROCESS privilege\)/),
      'R4 binary-log size: binary logging is off'
    ]);
    expect(r.readOnly).toBeNull();
  });

  it('R4: warns when binary logs exceed the threshold', async () => {
    const r = await adapterWith([
      writable,
      [/SHOW BINARY LOGS/, [[{ File_size: 600 * 1024 * 1024 }, { File_size: 600 * 1024 * 1024 }]]]
    ], { runtimeGates: { binlogWarnMb: 1000 } }).runtimePreflight({ locks: false });
    expect(r.warnings).toEqual([expect.stringMatching(/^Binary logs total 1200 MB \(over 1000 MB\)/)]);
  });

  it('runs only R3 when asked (dcl)', async () => {
    const adapter = adapterWith([writable]);
    await adapter.runtimePreflight({ locks: false, disk: false });
    expect(adapter.connection.query).toHaveBeenCalledTimes(1);
  });
});

describe('MongoDB runtimePreflight()', () => {
  function adapterWith({ hello, rsStatus, currentOp, dbStats }, config = {}) {
    const adapter = new MongoDBAdapter({ type: 'mongodb', mongodb: {}, ...config });
    const run = (value) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
    adapter.client = {
      db: () => ({
        command: vi.fn(async (cmd) => {
          if (cmd.hello) return run(hello);
          if (cmd.replSetGetStatus) return run(rsStatus);
          if (cmd.currentOp) return run(currentOp ?? { inprog: [] });
          throw new Error(`unexpected ${JSON.stringify(cmd)}`);
        })
      })
    };
    adapter.db = { databaseName: 'app', command: vi.fn(async () => run(dbStats ?? { fsTotalSize: 100, fsUsedSize: 10 })) };
    return adapter;
  }

  it('R3: a secondary is read-only (no override)', async () => {
    const r = await adapterWith({ hello: { isWritablePrimary: false, secondary: true, setName: 'rs0' }, rsStatus: { members: [] } }).runtimePreflight();
    expect(r.readOnly).toEqual({ reason: 'connected to a secondary' });
  });

  it('R3: replication lag above the threshold is a warning only', async () => {
    const now = Date.now();
    const r = await adapterWith({
      hello: { isWritablePrimary: true, setName: 'rs0' },
      rsStatus: { members: [
        { name: 'a:27017', stateStr: 'PRIMARY', optimeDate: new Date(now) },
        { name: 'b:27017', stateStr: 'SECONDARY', optimeDate: new Date(now - 120000) },
        { name: 'c:27017', stateStr: 'SECONDARY', optimeDate: new Date(now - 1000) }
      ] }
    }, { runtimeGates: { replicationLagWarnSec: 30 } }).runtimePreflight();
    expect(r.readOnly).toBeNull();
    expect(r.warnings).toEqual([expect.stringMatching(/^Secondary b:27017 is 120s behind/)]);
  });

  it('R2: long operations on this database and long-open transactions', async () => {
    const r = await adapterWith({
      hello: { isWritablePrimary: true },
      currentOp: { inprog: [
        { opid: 7, secs_running: 95, ns: 'app.orders', op: 'update', client: '10.0.0.5:5000', command: { update: 'orders' } },
        { opid: 8, transaction: { timeOpenMicros: 400e6 }, client: '10.0.0.6:5000' }
      ] }
    }).runtimePreflight();
    expect(r.openTransactions.map(t => [t.id, t.durationSec])).toEqual([['opid 7', 95], ['opid 8', 400]]);
  });

  it('R2/R4: skipped without privileges; disk usage over the threshold warns', async () => {
    const r = await adapterWith({
      hello: { isWritablePrimary: true },
      currentOp: new Error('not authorized on admin to execute command { currentOp: … }'),
      dbStats: { fsTotalSize: 100, fsUsedSize: 95 }
    }).runtimePreflight();
    expect(r.skipped).toEqual([expect.stringMatching(/^R2 long-operation check \(needs the inprog privilege/)]);
    expect(r.warnings).toEqual([expect.stringMatching(/^The database's filesystem is 95\.0% full/)]);
  });
});
