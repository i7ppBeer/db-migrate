/**
 * MariaDB Lock Guard — end-to-end regression test against a REAL server.
 *
 * Reproduces the incident this feature exists for: a long-running,
 * uncommitted transaction (e.g. a large batch DELETE) holds a table's
 * metadata lock (MDL) while this tool's `up()` tries to ALTER that same
 * table. Without a guard, the ALTER queues indefinitely for the exclusive
 * MDL — and because MariaDB's MDL queue is FIFO, any *new* query on that
 * table (including a plain SELECT) that arrives after the ALTER is already
 * queued gets stuck behind it too.
 *
 * This suite proves `executeWithLockGuard()` (src/adapters/mariadb-adapter.js)
 * fixes that: the guarded ALTER fails fast with a bounded wait instead of
 * hanging, retries successfully once the blocking transaction clears, and —
 * critically — does not leave a queued request that jams a later SELECT.
 *
 * Requires a real MariaDB reachable at MARIADB_HOST/PORT (defaults match
 * docker-compose.yml's `mariadb` service: localhost:3306, root/rootpass).
 * If nothing is listening, every test in this file is skipped (not failed)
 * so `npm run test:integration` degrades gracefully without Docker running.
 *
 * Run: npm run test:integration
 * (brings this up yourself first if needed: docker compose up -d mariadb)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { execSync } from 'child_process';
import path from 'path';
import { loadConfig, createAdapter } from '../src/adapters/index.js';

const HOST = process.env.MARIADB_HOST || 'localhost';
const PORT = parseInt(process.env.MARIADB_PORT || '3306', 10);
const ROOT_USER = process.env.MARIADB_USER || 'root';
const ROOT_PASSWORD = process.env.MARIADB_PASSWORD || 'rootpass';
const TEST_DB = process.env.MARIADB_LOCK_GUARD_DB || 'lock_guard_e2e_test';
const FIXTURE_CONFIG = 'test-fixtures/mariadb/lock-guard-e2e/ddl/config.js';

/**
 * Best-effort: bring up the docker-compose `mariadb` service if Docker is
 * available and nothing is already listening. Never throws — if Docker
 * isn't installed/running, we just fall through to the connectivity probe
 * below, which decides whether to skip the suite.
 */
function tryStartMariaDBContainer() {
  try {
    execSync('docker compose up -d mariadb', { stdio: 'ignore', timeout: 15000 });
  } catch {
    // Docker not available, or compose not runnable here — the connectivity
    // probe below will decide whether to skip; nothing else to do.
  }
}

/** Resolves true/false — never rejects. Short timeout so `npm test` (which
 *  does NOT run this file, see vitest.config.js) and CI both fail fast when
 *  there's genuinely no server, instead of hanging on TCP retries. */
async function isMariaDBReachable() {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: ROOT_USER,
      password: ROOT_PASSWORD,
      connectTimeout: 3000
    });
    await conn.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

tryStartMariaDBContainer();
const dbAvailable = await isMariaDBReachable();

if (!dbAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n⚠️  Skipping lock-guard e2e suite: no MariaDB reachable at ${HOST}:${PORT}.\n` +
    '   Run `docker compose up -d mariadb` (or set MARIADB_HOST/PORT) and re-run `npm run test:integration`.\n'
  );
}

describe.skipIf(!dbAvailable)('MariaDB lock guard — real-server e2e', () => {
  let rootConn;
  let adapter;
  let blockingConn;

  const withLockGuard = (overrides) => ({ lockGuard: { enabled: true, ...overrides } });

  beforeAll(async () => {
    rootConn = await mysql.createConnection({ host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASSWORD });
    await rootConn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);

    const config = await loadConfig(FIXTURE_CONFIG);
    // loadConfig() doesn't resolve migrationsDir relative to the config file
    // (only cli.js does that) — replicate it here since we bypass cli.js.
    if (!config.migrationsDir) {
      config.migrationsDir = path.resolve(path.dirname(path.resolve(FIXTURE_CONFIG)), 'migrations');
    } else if (!path.isAbsolute(config.migrationsDir)) {
      config.migrationsDir = path.resolve(path.dirname(path.resolve(FIXTURE_CONFIG)), config.migrationsDir);
    }
    adapter = createAdapter(config);
    await adapter.connect(); // creates the database + changelog table

    // Apply the baseline table migration (no contention involved).
    const baseline = await adapter.up({ only: '20260101000001' });
    expect(baseline.errors).toEqual([]);
    expect(baseline.applied).toHaveLength(1);
  }, 30000);

  afterAll(async () => {
    if (blockingConn) await blockingConn.end().catch(() => {});
    if (adapter) await adapter.disconnect().catch(() => {});
    if (rootConn) {
      await rootConn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
      await rootConn.end();
    }
  }, 30000);

  it('Scenario 1 — guarded ALTER fails fast (bounded wait) instead of hanging when a long transaction holds the table', async () => {
    // Reproduce the incident: an uncommitted DELETE holds the table's MDL.
    blockingConn = await mysql.createConnection({ host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASSWORD, database: TEST_DB });
    await blockingConn.query('START TRANSACTION');
    await blockingConn.query("DELETE FROM lock_guard_demo WHERE status = 'active'");
    // Deliberately NOT committed — this is the "large DELETE still running" state.

    adapter.config.ddlSafety = withLockGuard({ lockWaitTimeoutSec: 2, innodbLockWaitTimeoutSec: 2, maxRetries: 2, retryDelayMs: 300 });

    const startedAt = Date.now();
    const result = await adapter.up({ only: '20260101000002' });
    const elapsedMs = Date.now() - startedAt;

    // Failed, and reported as such — not silently swallowed.
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/lock wait timeout/i);
    expect(result.applied).toEqual([]);

    // Bounded: ~2 attempts * 2s wait + 1 retry delay (~4.3s), generous ceiling per plan.
    expect(elapsedMs).toBeGreaterThan(3000); // proves it actually engaged the lock wait, not an instant unrelated failure
    expect(elapsedMs).toBeLessThan(15000);   // proves it did NOT hang indefinitely — the regression this guards against

    // Migration is still pending — nothing left in a half-applied state.
    const status = await adapter.status();
    expect(status.pending).toContain('20260101000002-alter-lock-guard-demo.sql');

    // blockingConn is intentionally left OPEN here — Scenario 3 depends on
    // the lock still being held to prove downstream SELECTs aren't jammed.
  }, 20000);

  it('Scenario 3 — a plain SELECT on the same table is NOT stuck behind the abandoned ALTER request', async () => {
    // At this point: blockingConn's transaction is still open (from Scenario 1),
    // and the guarded adapter has already given up and returned control —
    // it is not parked waiting on the MDL queue anymore.
    const thirdConn = await mysql.createConnection({ host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASSWORD, database: TEST_DB });
    try {
      const startedAt = Date.now();
      const [rows] = await thirdConn.query('SELECT id FROM lock_guard_demo LIMIT 1');
      const elapsedMs = Date.now() - startedAt;

      expect(rows.length).toBe(1);
      // This is the concrete "SELECT stops working" claim from the incident —
      // with the guard in place, it should return almost immediately even
      // though a long transaction is still open on the same table.
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      await thirdConn.end();
    }

    // Clean up the blocking transaction now that both dependent scenarios ran.
    await blockingConn.query('ROLLBACK');
    await blockingConn.end();
    blockingConn = null;
  }, 10000);

  it('Scenario 2 — retries recover once the blocking transaction commits mid-retry-window', async () => {
    const conn2 = await mysql.createConnection({ host: HOST, port: PORT, user: ROOT_USER, password: ROOT_PASSWORD, database: TEST_DB });
    await conn2.query('START TRANSACTION');
    await conn2.query("DELETE FROM lock_guard_demo WHERE status = 'active'");

    // Release the lock partway through the retry window: attempt 1 (0-1s)
    // will still fail, but by attempt 2's wait window (~1.3-2.3s) it's free.
    const releaseAt = setTimeout(() => { conn2.query('COMMIT').catch(() => {}); }, 1500);

    try {
      adapter.config.ddlSafety = withLockGuard({ lockWaitTimeoutSec: 1, innodbLockWaitTimeoutSec: 1, maxRetries: 4, retryDelayMs: 300 });

      const startedAt = Date.now();
      const result = await adapter.up({ only: '20260101000002' });
      const elapsedMs = Date.now() - startedAt;

      expect(result.errors).toEqual([]);
      expect(result.applied).toEqual(['20260101000002-alter-lock-guard-demo.sql']);
      // Took at least one full failed attempt + retry delay before succeeding.
      expect(elapsedMs).toBeGreaterThan(1000);
      expect(elapsedMs).toBeLessThan(10000);

      const status = await adapter.status();
      expect(status.pending).not.toContain('20260101000002-alter-lock-guard-demo.sql');
    } finally {
      clearTimeout(releaseAt);
      await conn2.query('COMMIT').catch(() => {});
      await conn2.end();
    }
  }, 15000);
});
