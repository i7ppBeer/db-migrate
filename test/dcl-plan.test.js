/**
 * `dcl --plan` building blocks (src/core/dcl-plan.js) and R1 (DCL):
 * checksum records for scripts that are gone.
 */

import { describe, it, expect, vi } from 'vitest';
import { diffLines, compactDiff, accountsInSql, accountsInJs } from '../src/core/dcl-plan.js';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';

describe('diffLines / compactDiff', () => {
  it('marks changed lines and keeps the rest', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d.map(x => x.op + x.line)).toEqual([' a', '-b', '+B', ' c', '+d']);
  });

  it('compactDiff keeps changes with context and marks gaps', () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l1', 'L1').replace('l10', 'L10');
    const lines = compactDiff(diffLines(before, after), 1).map(x => x.op + x.line);
    expect(lines).toEqual([' l0', '-l1', '+L1', ' l2', '…', ' l9', '-l10', '+L10', ' l11']);
  });
});

describe('accountsInSql', () => {
  it('finds accounts per statement, ignoring comments, with placeholder use', () => {
    const sql = [
      "-- CREATE USER 'ghost'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';",
      "CREATE USER IF NOT EXISTS 'app_ro'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';",
      "GRANT SELECT ON app.* TO 'app_ro'@'%';",
      "ALTER USER 'svc'@'10.0.%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';",
      "DROP USER IF EXISTS 'old'@'localhost';"
    ].join('\n');
    expect(accountsInSql(sql)).toEqual([
      { user: 'app_ro', host: '%', kind: 'CREATE USER', placeholder: true },
      { user: 'app_ro', host: '%', kind: 'GRANT', placeholder: false },
      { user: 'svc', host: '10.0.%', kind: 'ALTER USER', placeholder: true },
      { user: 'old', host: 'localhost', kind: 'DROP USER', placeholder: false }
    ]);
  });
});

describe('accountsInJs', () => {
  it('finds user names in the common forms, not in comments', () => {
    const js = [
      '// createUser: "commented_out"',
      "const users = [{ username: 'a_ro', password: 'CHANGE_ME_ON_FIRST_LOGIN' }];",
      "await adminDb.command({ createUser: 'b_rw', pwd: 'x', roles: [] });",
      "await createOrUpdateUser(adminDb, { user: 'c_svc' });",
      "const username = 'd_legacy';"
    ].join('\n');
    expect(accountsInJs(js).map(a => a.user).sort()).toEqual(['a_ro', 'b_rw', 'c_svc', 'd_legacy']);
    expect(accountsInJs(js)[0].placeholder).toBe(true);
  });
});

describe('RepeatableRunner R1 (DCL): removed scripts', () => {
  function runnerWithStored(stored) {
    const runner = new RepeatableRunner({ checksumTable: 'dcl' });
    runner.getRepeatableFiles = vi.fn(async () => [{ fileName: 'R__001_keep.sql', checksum: 'k', content: 'x' }]);
    runner.getStoredChecksumsMongoDB = vi.fn(async () => new Map(Object.entries(stored)));
    return runner;
  }

  it('status() lists checksum records whose file is gone', async () => {
    const runner = runnerWithStored({
      'R__001_keep.sql': { checksum: 'k', appliedAt: new Date('2026-01-01') },
      'R__002_removed.sql': { checksum: 'r', appliedAt: new Date('2026-02-01') }
    });
    const status = await runner.status({ dbType: 'mongodb', db: {}, migrationsDir: '/x' });
    expect(status.orphaned).toEqual([{ fileName: 'R__002_removed.sql', appliedAt: new Date('2026-02-01') }]);
    expect(status.upToDate.map(u => u.fileName)).toEqual(['R__001_keep.sql']);
  });

  it('status() returns the previously applied content for a changed script', async () => {
    const runner = runnerWithStored({ 'R__001_keep.sql': { checksum: 'old', appliedAt: new Date(), content: 'before' } });
    const status = await runner.status({ dbType: 'mongodb', db: {}, migrationsDir: '/x' });
    expect(status.pending[0]).toMatchObject({ reason: 'checksum changed', previousContent: 'before', content: 'x' });
  });

  it('forgetChecksums() removes only the named records', async () => {
    const runner = new RepeatableRunner({ checksumTable: 'dcl' });
    const deleteMany = vi.fn();
    await runner.forgetChecksums({ dbType: 'mongodb', db: { collection: () => ({ deleteMany }) } }, ['R__002_removed.sql']);
    expect(deleteMany).toHaveBeenCalledWith({ _id: { $in: ['R__002_removed.sql'] } });

    const query = vi.fn();
    await runner.forgetChecksums({ dbType: 'mariadb', connection: { query } }, ['R__002_removed.sql']);
    expect(query).toHaveBeenCalledWith('DELETE FROM dcl WHERE id IN (?)', [['R__002_removed.sql']]);
  });
});
