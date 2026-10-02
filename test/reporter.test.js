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
import {
  buildSyncReport, syncReportToHTML, saveSyncReport,
  buildDCLNotificationEvents, passwordExpiryNote, notificationEmailToHTML, buildNotificationEmail,
  buildMultiInstanceSummary, multiInstanceSummaryToHTML, partialApplyNote,
  saveNotificationEmail, newRunId
} from '../src/core/reporter.js';
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

const emptyMariaDiff = { addedUsers: [], removedUsers: [], addedGrants: [], removedGrants: [] };

describe('buildDCLNotificationEvents', () => {
  it('MariaDB: a credential row and the diff row for the same account become one row', () => {
    const events = buildDCLNotificationEvents(
      [{ type: 'new', username: 'app_ro', host: '%', password: 'pw1' }],
      { ...emptyMariaDiff, addedUsers: ['app_ro@%', 'static_api@%'] },
      'mariadb'
    );
    expect(events).toEqual([
      { type: 'new', username: 'app_ro@%', password: 'pw1' },
      { type: 'new', username: 'static_api@%', password: null }
    ]);
  });

  it('created then rotated in the same run → one "new" row with only the final password', () => {
    const events = buildDCLNotificationEvents(
      [
        { type: 'new', username: 'svc', host: '%', password: 'first' },
        { type: 'password_changed', username: 'svc', host: '%', password: 'final' }
      ],
      { ...emptyMariaDiff, addedUsers: ['svc@%'] },
      'mariadb'
    );
    expect(events).toEqual([{ type: 'new', username: 'svc@%', password: 'final', supersededPasswords: 1 }]);
  });

  it('a later no_change never hides an earlier password', () => {
    const events = buildDCLNotificationEvents(
      [
        { type: 'password_changed', username: 'svc', host: '%', password: 'pw' },
        { type: 'no_change', username: 'svc', host: '%' }
      ],
      emptyMariaDiff,
      'mariadb'
    );
    expect(events).toEqual([{ type: 'password_changed', username: 'svc@%', password: 'pw' }]);
  });

  it('same user name on two hosts stays two accounts', () => {
    const events = buildDCLNotificationEvents(
      [
        { type: 'new', username: 'svc', host: '%', password: 'a' },
        { type: 'new', username: 'svc', host: 'localhost', password: 'b' }
      ],
      { ...emptyMariaDiff, addedUsers: ['svc@%', 'svc@localhost'] },
      'mariadb'
    );
    expect(events.map(e => [e.username, e.password])).toEqual([['svc@%', 'a'], ['svc@localhost', 'b']]);
  });

  it('MongoDB: matches the bare credential name to the diff\'s user@db and shows user@db once', () => {
    const events = buildDCLNotificationEvents(
      [{ type: 'new', username: 'mongo_ro', password: 'pw', expiry: { at: '2026-10-08T00:00:00.000Z' } }],
      { addedUsers: [{ user: 'mongo_ro', db: 'admin', roles: [] }], removedUsers: [], changedUsers: [] },
      'mongodb'
    );
    expect(events).toEqual([{ type: 'new', username: 'mongo_ro@admin', password: 'pw', expiry: { at: '2026-10-08T00:00:00.000Z' } }]);
  });
});

describe('passwordExpiryNote', () => {
  it('only claims "changed on first login" when PASSWORD EXPIRE was in the statement', () => {
    expect(passwordExpiryNote({ expiry: { onFirstLogin: true } })).toMatch(/changed on first login/);
    expect(passwordExpiryNote({})).toMatch(/does not force a change/);
    expect(passwordExpiryNote({})).not.toMatch(/first login/);
  });

  it('MongoDB: states the customData deadline and that it is not enforced', () => {
    const note = passwordExpiryNote({ expiry: { at: '2026-10-08T01:02:03.000Z' } });
    expect(note).toContain('2026-10-08');
    expect(note).toMatch(/does not enforce/);
  });

  it('renders into the email instead of the old unconditional claim', () => {
    const html = notificationEmailToHTML(buildNotificationEmail({
      project: 'app', target: '10.0.0.1:3306 · db app', dbType: 'mariadb',
      dcl: { events: [{ type: 'new', username: 'u@%', password: 'pw' }] }
    }));
    expect(html).not.toContain('expires on first login');
    expect(html).toContain('10.0.0.1:3306 · db app');
  });
});

describe('notification email fonts', () => {
  const html = notificationEmailToHTML(buildNotificationEmail({
    project: 'app', dbType: 'mariadb',
    dcl: { events: [{ type: 'new', username: 'u@%', password: 'pw-123' }] }
  }));

  it('uses a native monospace stack ending in Courier New, no webfonts', () => {
    expect(html).toContain("font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace");
    expect(html).not.toMatch(/@font-face|fonts\.googleapis/);
  });

  it('pins monospace elements to Courier New for Outlook (Word engine)', () => {
    expect(html).toContain("<!--[if mso]><style>.mono{font-family:'Courier New',monospace !important;}</style><![endif]-->");
    expect(html).toMatch(/<span class="mono" style="[^"]*">pw-123<\/span>/);
  });

  it('applies to the multi-instance summary too', () => {
    const summary = multiInstanceSummaryToHTML(buildMultiInstanceSummary({ project: 'p', instances: [{ name: 'prod-tw', dbType: 'mariadb', status: 'success' }] }));
    expect(summary).toContain('<!--[if mso]>');
    expect(summary).toContain('class="mono"');
  });
});

describe('buildMultiInstanceSummary / multiInstanceSummaryToHTML', () => {
  const instances = [
    {
      name: 'prod-tw', target: '10.0.0.1:3306 · db app', dbType: 'mariadb', status: 'success',
      events: [{ type: 'new', username: 'tw_report@%', password: 'TW-SECRET-1' }],
      notificationFile: 'reports/notification-prod-tw.html'
    },
    {
      name: 'prod-jp', target: '10.0.0.2:3306 · db app', dbType: 'mariadb', status: 'failed',
      events: [], errors: ['connect ETIMEDOUT']
    }
  ];

  it('never carries a password', () => {
    const report = buildMultiInstanceSummary({ project: 'dcl', instances });
    expect(JSON.stringify(report)).not.toContain('TW-SECRET-1');
    expect(report.instances[0].events[0]).toEqual({ type: 'new', username: 'tw_report@%', hasPassword: true });
    expect(multiInstanceSummaryToHTML(report)).not.toContain('TW-SECRET-1');
  });

  it('tells same-named databases apart by instance name and host, and rolls up failures', () => {
    const report = buildMultiInstanceSummary({ project: 'dcl', instances });
    expect(report.status).toBe('failed');
    expect(report.totals).toEqual({ instances: 2, failed: 1, events: 1 });
    const html = multiInstanceSummaryToHTML(report);
    for (const s of ['prod-tw', '10.0.0.1:3306 · db app', 'prod-jp', '10.0.0.2:3306 · db app', 'connect ETIMEDOUT', 'reports/notification-prod-tw.html']) {
      expect(html).toContain(escapeForHtml(s));
    }
  });
});

function escapeForHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

describe('partial-apply note in DDL failure emails', () => {
  it('is shown only when the migration failed while executing', () => {
    const failedDuringRun = notificationEmailToHTML(buildNotificationEmail({
      project: 'app', dbType: 'mariadb', status: 'failed',
      ddl: { applied: [], errors: ['f.sql: boom'], partialRisk: true }
    }));
    expect(failedDuringRun).toContain(partialApplyNote('mariadb'));
    expect(partialApplyNote('mariadb')).toMatch(/commits each DDL statement immediately/);
    expect(partialApplyNote('mongodb')).toMatch(/not transactional/);

    const refusedBeforeRun = notificationEmailToHTML(buildNotificationEmail({
      project: 'app', dbType: 'mariadb', status: 'failed',
      ddl: { applied: [], errors: ['Validation failed — nothing was applied'] }
    }));
    expect(refusedBeforeRun).not.toContain('may have been partly applied');
  });
});

describe('saveNotificationEmail', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db-migrate-notify-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('keeps every run\'s email: a later run never overwrites an earlier one', async () => {
    const first = await saveNotificationEmail(dir, '<p>run 1 password</p>');
    const second = await saveNotificationEmail(dir, '<p>run 2 password</p>');

    expect(first.path).not.toBe(second.path);
    expect(await fs.readFile(first.path, 'utf-8')).toBe('<p>run 1 password</p>');
    expect(await fs.readFile(second.path, 'utf-8')).toBe('<p>run 2 password</p>');
    // The fixed path holds the latest run
    expect(second.latestPath).toBe(path.join(dir, 'notification.html'));
    expect(await fs.readFile(second.latestPath, 'utf-8')).toBe('<p>run 2 password</p>');
  });

  it('names run files after the fixed name and a sortable run id', async () => {
    const saved = await saveNotificationEmail(dir, 'x', 'notification-prod-tw.html', { runId: '20261001T105432Z-3f9a' });
    expect(path.basename(saved.path)).toBe('notification-prod-tw-20261001T105432Z-3f9a.html');
    expect(newRunId(new Date('2026-10-01T10:54:32.123Z'))).toMatch(/^20261001T105432Z-[0-9a-f]{4}$/);
  });

  it('writes both files readable by the owner only', async () => {
    if (process.platform === 'win32') return;
    const saved = await saveNotificationEmail(dir, 'secret');
    expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(saved.latestPath)).mode & 0o777).toBe(0o600);
  });

  it('concurrent runs each keep their own file, and leave no temp files behind', async () => {
    const saves = await Promise.all(Array.from({ length: 10 }, (_, i) => saveNotificationEmail(dir, `run ${i}`)));
    expect(new Set(saves.map(s => s.path)).size).toBe(10);
    const names = await fs.readdir(dir);
    expect(names.filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(names).toHaveLength(11); // 10 run files + notification.html
  });

  it('refuses to overwrite an existing run file (same run id twice)', async () => {
    await saveNotificationEmail(dir, 'first', 'notification.html', { runId: 'same' });
    await expect(saveNotificationEmail(dir, 'second', 'notification.html', { runId: 'same' })).rejects.toThrow(/EEXIST/);
  });

  const runIdAt = (i) => `2026100${Math.floor(i / 10)}T00000${i % 10}Z-abcd`;

  it('keeps only the newest keepRuns copies of each name, and always the latest copy', async () => {
    for (let i = 0; i < 5; i++) {
      await saveNotificationEmail(dir, `run ${i}`, 'notification.html', { runId: runIdAt(i), keepRuns: 3 });
    }
    // another name's copies are not this name's to prune
    await saveNotificationEmail(dir, 'tw', 'notification-prod-tw.html', { runId: runIdAt(0), keepRuns: 3 });
    const names = (await fs.readdir(dir)).sort();
    expect(names).toEqual([
      'notification-20261000T000002Z-abcd.html',
      'notification-20261000T000003Z-abcd.html',
      'notification-20261000T000004Z-abcd.html',
      'notification-prod-tw-20261000T000000Z-abcd.html',
      'notification-prod-tw.html',
      'notification.html'
    ]);
    expect(await fs.readFile(path.join(dir, 'notification.html'), 'utf-8')).toBe('run 4');
  });

  it('keeps 20 copies by default and every copy with keepRuns: 0', async () => {
    for (let i = 0; i < 22; i++) await saveNotificationEmail(dir, `run ${i}`, 'notification.html', { runId: runIdAt(i) });
    expect((await fs.readdir(dir)).filter(n => n !== 'notification.html')).toHaveLength(20);
    const last = await saveNotificationEmail(dir, 'all', 'notification.html', { runId: runIdAt(25), keepRuns: 0 });
    expect(last.removed).toEqual([]);
    expect((await fs.readdir(dir)).filter(n => n !== 'notification.html')).toHaveLength(21);
  });

  it('an invalid keepRuns still saves the email and only warns', async () => {
    const saved = await saveNotificationEmail(dir, 'pw', 'notification.html', { keepRuns: -1 });
    expect(await fs.readFile(saved.path, 'utf-8')).toBe('pw');
    expect(saved.warning).toMatch(/notifications\.keepRuns must be/);
  });
});
