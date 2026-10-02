/**
 * MySQL compatibility — the CLI against a REAL MySQL 8, including upgrading
 * bookkeeping tables written by older versions of this tool.
 *
 * The tool's SQL is developed and tested against MariaDB; MySQL rejects some
 * MariaDB extensions (e.g. ALTER TABLE … ADD COLUMN IF NOT EXISTS, which once
 * made every DDL connect fail on MySQL). This suite runs the real CLI
 * (`node src/cli.js …`) so anything MariaDB-only on these paths shows up.
 *
 * Requires MySQL at MYSQL_HOST/MYSQL_PORT (default localhost:3307, root/rootpass):
 *   docker run -d --rm --name mysql-compat -p 3307:3306 -e MYSQL_ROOT_PASSWORD=rootpass mysql:8.4
 * Skipped when unreachable, unless MYSQL_REQUIRE_DB=1 (CI), which fails instead.
 *
 * Run: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const HOST = process.env.MYSQL_HOST || 'localhost';
const PORT = parseInt(process.env.MYSQL_PORT || '3307', 10);
const USER = process.env.MYSQL_USER || 'root';
const PASSWORD = process.env.MYSQL_PASSWORD || 'rootpass';
const DB = 'mysql_compat_test';
const APP_USER = 'mysql_compat_app';
const CLI = path.resolve('src/cli.js');

async function isReachable() {
  let conn;
  try {
    conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, connectTimeout: 3000 });
    const [[{ v }]] = await conn.query('SELECT VERSION() AS v');
    return !/mariadb/i.test(v); // this suite is about MySQL specifically
  } catch {
    return false;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

const available = await isReachable();
if (!available && process.env.MYSQL_REQUIRE_DB === '1') {
  throw new Error(`MYSQL_REQUIRE_DB=1 but no MySQL is reachable at ${HOST}:${PORT}`);
}
if (!available) {
  console.warn(`\n⚠️  Skipping MySQL compatibility suite: no MySQL reachable at ${HOST}:${PORT} (see the header of test/mysql-compat.test.js).\n`);
}

describe.skipIf(!available)('MySQL compatibility — real-server CLI run', () => {
  let conn;
  let dir;

  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf-8', timeout: 60000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const columns = async (table) => {
    const [rows] = await conn.query(
      'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [DB, table]
    );
    return rows.map(r => r.c);
  };

  beforeAll(async () => {
    conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, multipleStatements: true });
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\`; DROP USER IF EXISTS '${APP_USER}'@'%'; CREATE DATABASE \`${DB}\``);
    // Bookkeeping as older versions left it: changelog without `checksum`
    // (first migration applied), DCL checksum table without `content`.
    await conn.query(`
      USE \`${DB}\`;
      CREATE TABLE users (id BIGINT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(255) NOT NULL);
      CREATE TABLE schema_migrations (id VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO schema_migrations (id) VALUES ('20260101000001-create-users');
      CREATE TABLE dcl_repeatable_migrations (id VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
    `);

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mysql-compat-'));
    await fs.mkdir(path.join(dir, 'ddl'));
    await fs.mkdir(path.join(dir, 'dcl'));
    await fs.writeFile(path.join(dir, 'ddl', '20260101000001-create-users.sql'),
      '-- +migrate Up\nCREATE TABLE users (id BIGINT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(255) NOT NULL);\n-- +migrate Down\nDROP TABLE users;\n');
    await fs.writeFile(path.join(dir, 'ddl', '20260101000002-add-name.sql'),
      '-- +migrate Up\nALTER TABLE users ADD COLUMN name VARCHAR(100) NULL;\n-- +migrate Down\nALTER TABLE users DROP COLUMN name;\n');
    await fs.writeFile(path.join(dir, 'dcl', 'R__01_app.sql'),
      `CREATE USER IF NOT EXISTS '${APP_USER}'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';\nGRANT SELECT, INSERT ON ${DB}.* TO '${APP_USER}'@'%';\n`);
    const connection = `mariadb: { host: '${HOST}', port: ${PORT}, database: '${DB}', user: '${USER}', password: '${PASSWORD}' }`;
    await fs.writeFile(path.join(dir, 'ddl.config.mjs'), `export default { type: 'mariadb', migrationsDir: './ddl', ${connection} };\n`);
    await fs.writeFile(path.join(dir, 'dcl.config.mjs'),
      `export default { type: 'mariadb', mode: 'repeatable', checksumTable: 'dcl_repeatable_migrations', migrationsDir: './dcl', ${connection} };\n`);
  });

  afterAll(async () => {
    if (conn) {
      await conn.query(`DROP DATABASE IF EXISTS \`${DB}\`; DROP USER IF EXISTS '${APP_USER}'@'%'`).catch(() => {});
      await conn.end();
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('read-only commands work on old-format tables and leave them unchanged', async () => {
    for (const args of [['status'], ['baseline', '--all', '--dry-run'], ['up', '--dry-run']]) {
      const r = cli(...args, '-c', 'ddl.config.mjs');
      expect(r.code, `${args.join(' ')}\n${r.out}`).toBe(0);
    }
    expect(await columns('schema_migrations')).toEqual(['id', 'applied_at']);
  });

  it('sync adds the checksum column, baselines the old row and applies the pending migration', async () => {
    const r = cli('sync', '-c', 'ddl.config.mjs', '-o', 'out');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Adopted checksum baseline for 1');
    expect(await columns('schema_migrations')).toEqual(['id', 'applied_at', 'checksum']);
    const [rows] = await conn.query(`SELECT id, checksum IS NOT NULL AS has FROM \`${DB}\`.schema_migrations ORDER BY id`);
    expect(rows.map(x => [x.id, Number(x.has)])).toEqual([['20260101000001-create-users', 1], ['20260101000002-add-name', 1]]);
  });

  it('down and up again', async () => {
    expect(cli('down', '--yes', '-c', 'ddl.config.mjs').code).toBe(0);
    expect(await columns('users')).toEqual(['id', 'email']);
    expect(cli('up', '-c', 'ddl.config.mjs').code).toBe(0);
    expect(await columns('users')).toEqual(['id', 'email', 'name']);
  });

  it('DCL: plan, apply (adding the content column to the old table), then up to date', async () => {
    expect(cli('dcl', '--plan', '-c', 'dcl.config.mjs').code).toBe(0);
    expect(await columns('dcl_repeatable_migrations')).toEqual(['id', 'checksum', 'applied_at']); // --plan is read-only
    const run = cli('dcl', '-c', 'dcl.config.mjs', '-o', 'out');
    expect(run.code, run.out).toBe(0);
    expect(await columns('dcl_repeatable_migrations')).toEqual(['id', 'checksum', 'applied_at', 'content']);
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM mysql.user WHERE User = ?', [APP_USER]);
    expect(Number(n)).toBe(1);
    expect(cli('dcl:status', '-c', 'dcl.config.mjs').out).toMatch(/Pending \(0\)/);
  });
});
