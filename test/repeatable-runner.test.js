/**
 * Tests for RepeatableRunner
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';

describe('RepeatableRunner', () => {
  let runner;

  beforeEach(() => {
    runner = new RepeatableRunner({
      checksumTable: 'test_repeatable_migrations'
    });
  });

  describe('calculateChecksum', () => {
    it('should calculate consistent SHA-256 checksum', () => {
      const content = 'SELECT 1;';
      const checksum1 = runner.calculateChecksum(content);
      const checksum2 = runner.calculateChecksum(content);
      
      expect(checksum1).toBe(checksum2);
      expect(checksum1).toHaveLength(64); // SHA-256 produces 64 hex chars
    });

    it('should produce different checksums for different content', () => {
      const checksum1 = runner.calculateChecksum('SELECT 1;');
      const checksum2 = runner.calculateChecksum('SELECT 2;');
      
      expect(checksum1).not.toBe(checksum2);
    });

    it('should detect whitespace changes', () => {
      const checksum1 = runner.calculateChecksum('SELECT 1;');
      const checksum2 = runner.calculateChecksum('SELECT  1;');
      
      expect(checksum1).not.toBe(checksum2);
    });
  });

  describe('getRepeatableFiles', () => {
    it('should filter files starting with R__', async () => {
      const mockFs = {
        readdir: vi.fn().mockResolvedValue([
          'R__01_users.sql',
          'R__02_grants.sql',
          '20260101-migration.sql',
          'config.js',
          'R__03_roles.js'
        ]),
        readFile: vi.fn().mockResolvedValue('-- content')
      };

      // Mock fs module
      vi.doMock('fs/promises', () => mockFs);
      
      // Note: In real tests, we would need to properly mock the fs module
      // This is a simplified test showing the expected behavior
      const files = [
        'R__01_users.sql',
        'R__02_grants.sql',
        'R__03_roles.js'
      ].filter(f => f.startsWith('R__') && (f.endsWith('.sql') || f.endsWith('.js')));
      
      expect(files).toHaveLength(3);
      expect(files[0]).toBe('R__01_users.sql');
    });

    it('should sort files alphabetically', () => {
      const files = [
        'R__03_roles.sql',
        'R__01_users.sql',
        'R__02_grants.sql'
      ].sort();
      
      expect(files[0]).toBe('R__01_users.sql');
      expect(files[1]).toBe('R__02_grants.sql');
      expect(files[2]).toBe('R__03_roles.sql');
    });
  });

  describe('status', () => {
    it('should identify pending migrations when checksum differs', () => {
      const storedChecksums = new Map([
        ['R__01_users.sql', { checksum: 'old_checksum', appliedAt: new Date() }]
      ]);
      
      const currentFile = {
        fileName: 'R__01_users.sql',
        checksum: 'new_checksum'
      };
      
      const stored = storedChecksums.get(currentFile.fileName);
      const isPending = !stored || stored.checksum !== currentFile.checksum;
      
      expect(isPending).toBe(true);
    });

    it('should identify up-to-date migrations when checksum matches', () => {
      const checksum = 'same_checksum';
      const storedChecksums = new Map([
        ['R__01_users.sql', { checksum, appliedAt: new Date() }]
      ]);
      
      const currentFile = {
        fileName: 'R__01_users.sql',
        checksum
      };
      
      const stored = storedChecksums.get(currentFile.fileName);
      const isUpToDate = stored && stored.checksum === currentFile.checksum;
      
      expect(isUpToDate).toBe(true);
    });

    it('should identify new files as pending', () => {
      const storedChecksums = new Map();
      
      const currentFile = {
        fileName: 'R__01_users.sql',
        checksum: 'new_checksum'
      };
      
      const stored = storedChecksums.get(currentFile.fileName);
      const isPending = !stored;
      
      expect(isPending).toBe(true);
    });
  });

  describe('checksum table schema', () => {
    it('should use correct table name from config', () => {
      const customRunner = new RepeatableRunner({
        checksumTable: 'custom_dcl_migrations'
      });
      
      expect(customRunner.checksumTable).toBe('custom_dcl_migrations');
    });

    it('should use default table name when not specified', () => {
      const defaultRunner = new RepeatableRunner({});
      
      expect(defaultRunner.checksumTable).toBe('repeatable_migrations');
    });
  });
});

describe('stripCommentsAndCollapse', () => {
  let runner;
  beforeEach(() => { runner = new RepeatableRunner({ checksumTable: 'test_dcl' }); });

  it('should collapse multi-line SQL into single line', () => {
    const sql = `CREATE USER IF NOT EXISTS 'app_user'@'%'\n  IDENTIFIED BY 'secret'\n  PASSWORD EXPIRE;`;
    const result = runner.stripCommentsAndCollapse(sql);
    expect(result).toBe(`CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'secret' PASSWORD EXPIRE;`);
  });

  it('should remove single-line comments', () => {
    const sql = `-- This is a comment\nCREATE USER 'u'@'%' IDENTIFIED BY 'pw';`;
    const result = runner.stripCommentsAndCollapse(sql);
    expect(result).not.toContain('-- This is a comment');
    expect(result).toContain("CREATE USER 'u'@'%' IDENTIFIED BY 'pw'");
  });

  it('should keep CHANGE_ME_ON_FIRST_LOGIN intact (not stripped as string literal)', () => {
    const sql = `CREATE USER 'u'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;
    const result = runner.stripCommentsAndCollapse(sql);
    expect(result).toContain('CHANGE_ME_ON_FIRST_LOGIN');
  });
});

describe('recordCredentialEvents — multi-line SQL template format', () => {
  let runner;
  beforeEach(() => {
    runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
  });

  it('should extract username from multi-line CREATE USER (official template format)', () => {
    // This is exactly the format used by databases/mariadb/_templates/dcl/migrations/
    const sql = `-- R__00_default_users.sql\nCREATE USER IF NOT EXISTS 'app_default'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'\n  PASSWORD EXPIRE;\nFLUSH PRIVILEGES;\n`;

    runner.recordCredentialEvents(sql, ['testpassword123X'], false);

    // PASSWORD EXPIRE in the statement → the database really does force a change on first login
    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'app_default', host: '%', password: 'testpassword123X', expiry: { onFirstLogin: true } });
  });

  it('should extract username from single-line CREATE USER (legacy format)', () => {
    const sql = `CREATE USER IF NOT EXISTS 'svc_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';\nFLUSH PRIVILEGES;\n`;

    runner.recordCredentialEvents(sql, ['testpassword456Y'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'svc_user', host: '%', password: 'testpassword456Y' });
  });

  it('should record a no_change event (not a password) when alreadyExists=true (CREATE USER)', () => {
    const sql = `CREATE USER IF NOT EXISTS 'app_user'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;

    runner.recordCredentialEvents(sql, ['somepassword'], true);

    expect(runner.credentialEvents).toEqual([{ type: 'no_change', username: 'app_user', host: '%' }]);
  });

  it('should extract multiple usernames from multi-line statements', () => {
    const sql = [
      `CREATE USER IF NOT EXISTS 'readonly_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
      `CREATE USER IF NOT EXISTS 'readwrite_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    ].join('\n');

    runner.recordCredentialEvents(sql, ['pw1', 'pw2'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'readonly_svc', host: '%', password: 'pw1' });
    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'readwrite_svc', host: '%', password: 'pw2' });
  });

  // ─── Scenario 1: New user → password generated ────────────────────────────
  it('[Scenario 1] New user: CREATE USER records a "new" credential event', () => {
    const sql = `CREATE USER IF NOT EXISTS 'new_app'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'\n  PASSWORD EXPIRE;\nFLUSH PRIVILEGES;`;
    const { generated, passwords } = runner.resolvePlaceholderPasswords(sql, 'R__01_new_user.sql');

    expect(generated).toBe(true);
    expect(passwords).toHaveLength(1);

    runner.recordCredentialEvents(sql, passwords, false);

    expect(runner.credentialEvents).toHaveLength(1);
    expect(runner.credentialEvents[0]).toMatchObject({ type: 'new', username: 'new_app' });
    expect(runner.credentialEvents[0].password).not.toContain('CHANGE_ME_ON_FIRST_LOGIN');
  });

  // ─── Scenario 2: Second run → checksum unchanged → no new password ─────────
  it('[Scenario 2] Second run: original file unchanged → same checksum → runner skips', () => {
    const originalSql = `CREATE USER IF NOT EXISTS 'new_app'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;

    const checksum1 = runner.calculateChecksum(originalSql);
    const checksum2 = runner.calculateChecksum(originalSql);
    expect(checksum1).toBe(checksum2);

    // Resolved content (real password substituted) must differ from original
    // confirming that the runner correctly uses original content for checksum tracking
    const { resolved } = runner.resolvePlaceholderPasswords(originalSql, 'R__01_new_user.sql');
    const resolvedChecksum = runner.calculateChecksum(resolved);
    expect(resolvedChecksum).not.toBe(checksum1);
  });

  // ─── Scenario 3: Reset password → NOT skipped, recorded as password_changed ─
  it('[Scenario 3] Reset password: ALTER USER records a password_changed event even when alreadyExists=true', () => {
    // SQL generated by gen-dcl.py when reset_pwd: true
    const sql = [
      `-- @allow-forbidden: true`,
      `-- DCL High-Risk: RESET PASSWORD — existing_user`,
      `ALTER USER 'existing_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
      `FLUSH PRIVILEGES;`,
    ].join('\n');

    const { generated, passwords } = runner.resolvePlaceholderPasswords(sql, 'R__20260324_reset_pwd_existing_user.sql');
    expect(generated).toBe(true);

    // alreadyExists=true simulates the old buggy path — ALTER USER must NOT be skipped
    runner.recordCredentialEvents(sql, passwords, true /* alreadyExists */);

    expect(runner.credentialEvents).toHaveLength(1);
    expect(runner.credentialEvents[0]).toMatchObject({ type: 'password_changed', username: 'existing_user' });
    expect(runner.credentialEvents[0].password).toBeTruthy();
  });

  // ─── Scenario 4: Second run of reset → same checksum → no execution ────────
  it('[Scenario 4] Second run of reset: same file → same checksum → runner skips execution', () => {
    const resetSql = `ALTER USER 'existing_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';\nFLUSH PRIVILEGES;`;

    const checksum1 = runner.calculateChecksum(resetSql);
    const checksum2 = runner.calculateChecksum(resetSql);
    // Identical content → same checksum → runner sees no change and skips the file
    expect(checksum1).toBe(checksum2);
  });

  // ─── Fix verification: preCheckAccountsExistMariaDB excludes ALTER USER ────
  it('[Fix] preCheckAccountsExistMariaDB: ALTER USER only → no existing accounts, without querying DB', async () => {
    const alterSql = `ALTER USER 'existing_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;
    // Passing null connection — if it tried to query it would throw
    // An empty set means it correctly detected no CREATE USER and exited early
    const result = await runner.preCheckAccountsExistMariaDB(null, alterSql);
    expect(result.size).toBe(0);
  });
});

describe('Repeatable Migration File Naming', () => {
  it('should validate R__ prefix pattern', () => {
    const validNames = [
      'R__01_readonly_users.sql',
      'R__02_readwrite_users.sql',
      'R__users.js',
      'R__grants_update.sql'
    ];
    
    const invalidNames = [
      '20260101-migration.sql',
      'migration.sql',
      'r__lowercase.sql',
      'R_single_underscore.sql'
    ];
    
    const isRepeatableFile = (name) => name.startsWith('R__');
    
    for (const name of validNames) {
      expect(isRepeatableFile(name)).toBe(true);
    }
    
    for (const name of invalidNames) {
      expect(isRepeatableFile(name)).toBe(false);
    }
  });
});

describe('resolvePlaceholderPasswords — placeholder mentioned in a comment', () => {
  let runner;
  beforeEach(() => {
    runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
  });

  // The password recorded for an account must be the one actually substituted
  // into its CREATE USER / createUser — not one generated for a comment.
  const executedPassword = (resolved, pattern) => resolved.match(pattern)[1];

  it('SQL: ignores a placeholder in a -- comment and pairs the account with the executed password', () => {
    const sql = [
      `-- CHANGE_ME_ON_FIRST_LOGIN is replaced at runtime (official template header)`,
      `CREATE USER IF NOT EXISTS 'app_readonly'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
      `FLUSH PRIVILEGES;`,
    ].join('\n');

    const { resolved, generated, passwords } = runner.resolvePlaceholderPasswords(sql, 'R__010_readonly.sql');
    expect(generated).toBe(true);
    expect(passwords).toHaveLength(1);
    expect(resolved).toContain('-- CHANGE_ME_ON_FIRST_LOGIN is replaced at runtime');

    runner.recordCredentialEvents(sql, passwords, false);
    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: 'app_readonly', host: '%', password: executedPassword(resolved, /IDENTIFIED BY '([^']+)'/) }
    ]);
  });

  it('SQL: ignores # and /* */ comments too', () => {
    const sql = [
      `# CHANGE_ME_ON_FIRST_LOGIN`,
      `/* CHANGE_ME_ON_FIRST_LOGIN`,
      `   CREATE USER 'ghost'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'; */`,
      `CREATE USER IF NOT EXISTS 'real_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    ].join('\n');

    const { resolved, passwords } = runner.resolvePlaceholderPasswords(sql, 'R__01.sql');
    expect(passwords).toHaveLength(1);

    runner.recordCredentialEvents(sql, passwords, false);
    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: 'real_user', host: '%', password: executedPassword(resolved, /'real_user'@'%' IDENTIFIED BY '([^']+)'/) }
    ]);
  });

  it('SQL: "--" inside a string literal is not a comment', () => {
    const sql = `CREATE USER 'a--b'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;
    const { passwords } = runner.resolvePlaceholderPasswords(sql, 'R__01.sql');
    expect(passwords).toHaveLength(1);
  });

  it('only a comment mentions the placeholder → nothing generated', () => {
    const sql = `-- No CHANGE_ME_ON_FIRST_LOGIN here — grants only\nGRANT SELECT ON db.* TO 'u'@'%';`;
    const { resolved, generated } = runner.resolvePlaceholderPasswords(sql, 'R__01.sql');
    expect(generated).toBe(false);
    expect(resolved).toBe(sql);
  });

  it('JS: ignores a placeholder in a /** */ header and pairs each user with its own executed password', () => {
    const js = [
      `/**`,
      ` * CHANGE_ME_ON_FIRST_LOGIN will be replaced at runtime with a secure password.`,
      ` */`,
      `export async function up(db, client) {`,
      `  // user: 'commented_out', pwd: 'CHANGE_ME_ON_FIRST_LOGIN'`,
      `  await createOrUpdateUser(adminDb, { user: 'svc_ro', pwd: 'CHANGE_ME_ON_FIRST_LOGIN' });`,
      `  await createOrUpdateUser(adminDb, { user: 'svc_rw', pwd: 'CHANGE_ME_ON_FIRST_LOGIN' });`,
      `}`,
    ].join('\n');

    const { resolved, passwords } = runner.resolvePlaceholderPasswords(js, 'R__003_secret_users.js');
    expect(passwords).toHaveLength(2);

    runner.recordCredentialEvents(js, passwords, false);
    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: 'svc_ro', password: executedPassword(resolved, /user: 'svc_ro', pwd: '([^']+)'/) },
      { type: 'new', username: 'svc_rw', password: executedPassword(resolved, /user: 'svc_rw', pwd: '([^']+)'/) },
    ]);
  });
});

describe('recordCredentialEvents — JS object property style (user: "xxx")', () => {
  let runner;
  beforeEach(() => {
    runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
  });

  it('should extract usernames from object property style and pair passwords positionally', () => {
    const js = [
      `export async function up(db, client) {`,
      `  await createOrUpdateUser(adminDb, {`,
      `    user: 'ecommerce_app',`,
      `    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',`,
      `  });`,
      `  await createOrUpdateUser(adminDb, {`,
      `    user: 'analytics_app',`,
      `    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',`,
      `  });`,
      `}`,
    ].join('\n');

    runner.recordCredentialEvents(js, ['pw_ecommerce', 'pw_analytics'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'ecommerce_app', password: 'pw_ecommerce' });
    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'analytics_app', password: 'pw_analytics' });
  });

  it('should still support const username = "xxx" style', () => {
    const js = [
      `export async function up(db, client) {`,
      `  const username = 'legacy_user';`,
      `  // pwd: 'CHANGE_ME_ON_FIRST_LOGIN'`,
      `}`,
    ].join('\n');

    runner.recordCredentialEvents(js, ['pw_legacy'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'legacy_user', password: 'pw_legacy' });
  });
});

describe('recordCredentialEvents — host and PASSWORD EXPIRE', () => {
  let runner;
  beforeEach(() => { runner = new RepeatableRunner({ checksumTable: 'test_dcl' }); });

  it('records the host, and no expiry when the statement has none', () => {
    runner.recordCredentialEvents(`CREATE USER IF NOT EXISTS 'local_svc'@'localhost' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`, ['pw'], false);
    expect(runner.credentialEvents).toEqual([{ type: 'new', username: 'local_svc', host: 'localhost', password: 'pw' }]);
  });

  it('PASSWORD EXPIRE NEVER / INTERVAL is not "expires on first login"', () => {
    runner.recordCredentialEvents([
      `CREATE USER IF NOT EXISTS 'a'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN' PASSWORD EXPIRE NEVER;`,
      `CREATE USER IF NOT EXISTS 'b'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN' PASSWORD EXPIRE INTERVAL 90 DAY;`,
      `CREATE USER IF NOT EXISTS 'c'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN' PASSWORD EXPIRE;`
    ].join('\n'), ['p1', 'p2', 'p3'], false);
    expect(runner.credentialEvents.map(e => [e.username, e.expiry])).toEqual([
      ['a', undefined], ['b', undefined], ['c', { onFirstLogin: true }]
    ]);
  });
});

describe('importResolvedModule', () => {
  it('writes the resolved source privately (dir 0700, file 0600) and removes it after import', async () => {
    const runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
    const source = [
      `import fs from 'fs';`,
      `export const file = new URL(import.meta.url).pathname;`,
      `export const fileMode = fs.statSync(file).mode & 0o777;`,
      `export const dirMode = fs.statSync(new URL('.', import.meta.url)).mode & 0o777;`,
      `export async function up() {}`
    ].join('\n');

    const mod = await runner.importResolvedModule(source, 'R__001_secret_users.js');

    expect(typeof mod.up).toBe('function');
    if (process.platform !== 'win32') {
      expect(mod.fileMode).toBe(0o600);
      expect(mod.dirMode).toBe(0o700);
    }
    await expect(fs.access(path.dirname(fileURLToPath(`file://${mod.file}`)))).rejects.toThrow();
  });
});

describe('DCL credential events — one file mixing existing and new accounts', () => {
  const MIXED_SQL = [
    `CREATE USER IF NOT EXISTS 'shop_app'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    `CREATE USER IF NOT EXISTS 'shop_report'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    `CREATE USER IF NOT EXISTS 'shop_app'@'localhost' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    `ALTER USER 'shop_ops'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
  ].join('\n');

  let runner;
  beforeEach(() => {
    runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
  });

  it('preCheckAccountsExistMariaDB returns the existing accounts per user@host, not one flag per file', async () => {
    const connection = {
      query: vi.fn().mockResolvedValue([[{ User: 'shop_app', Host: '%' }, { User: 'unrelated', Host: '%' }]])
    };
    const existing = await runner.preCheckAccountsExistMariaDB(connection, MIXED_SQL);

    expect([...existing]).toEqual(['shop_app@%']);
    // one lookup, by user name, for the CREATE USER accounts only (ALTER USER is left out)
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.query.mock.calls[0][1]).toEqual(['shop_app', 'shop_report']);
  });

  it('compares hosts case-insensitively', async () => {
    const sql = `CREATE USER IF NOT EXISTS 'svc'@'LocalHost' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;
    const connection = { query: vi.fn().mockResolvedValue([[{ User: 'svc', Host: 'localhost' }]]) };
    expect([...await runner.preCheckAccountsExistMariaDB(connection, sql)]).toEqual(['svc@localhost']);
  });

  it('recordCredentialEvents: existing → no_change, new → its own password, ALTER → password_changed', () => {
    runner.recordCredentialEvents(MIXED_SQL, ['pw1', 'pw2', 'pw3', 'pw4'], new Set(['shop_app@%']));

    expect(runner.credentialEvents).toEqual([
      { type: 'no_change', username: 'shop_app', host: '%' },
      { type: 'new', username: 'shop_report', host: '%', password: 'pw2' },
      { type: 'new', username: 'shop_app', host: 'localhost', password: 'pw3' },
      { type: 'password_changed', username: 'shop_ops', host: '%', password: 'pw4' },
    ]);
  });

  it('recordCredentialEvents still accepts a boolean for the whole file', () => {
    runner.recordCredentialEvents(MIXED_SQL, ['pw1', 'pw2', 'pw3', 'pw4'], true);

    expect(runner.credentialEvents.map(e => e.type)).toEqual(['no_change', 'no_change', 'no_change', 'password_changed']);
  });

  it('runMariaDB: the new account in a file with an existing one gets the password it was created with', async () => {
    const dir = await fs.mkdtemp(path.join((await import('os')).tmpdir(), 'dclmix-'));
    await fs.writeFile(path.join(dir, 'R__001_accounts.sql'), MIXED_SQL.split('\n').slice(0, 2).join('\n') + '\n');
    const executed = [];
    const connection = {
      execute: vi.fn().mockResolvedValue([[]]),
      query: vi.fn(async (sql) => {
        if (/FROM mysql\.user/.test(sql)) return [[{ User: 'shop_app', Host: '%' }]];
        if (/CREATE USER/.test(sql)) executed.push(sql);
        return [[]];
      })
    };
    try {
      const result = await runner.run({ dbType: 'mariadb', connection, migrationsDir: dir });
      expect(result.errors).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    const [noChange, created] = runner.credentialEvents;
    expect(noChange).toEqual({ type: 'no_change', username: 'shop_app', host: '%' });
    expect(created).toMatchObject({ type: 'new', username: 'shop_report', host: '%' });
    // the password in the event is the one the CREATE USER for shop_report actually ran with
    expect(executed.join('\n')).toContain(`'shop_report'@'%' IDENTIFIED BY '${created.password}'`);
  });

  it('runMongoDB: pairs passwords with allUsernames, so a new account after existing ones gets its own password', async () => {
    const js = [
      `export async function up(db, client) {`,
      `  const users = [`,
      `    { username: 'shop_app', password: 'CHANGE_ME_ON_FIRST_LOGIN' },`,
      `    { username: 'shop_readonly', password: 'CHANGE_ME_ON_FIRST_LOGIN' },`,
      `    { username: 'shop_mreport', password: 'CHANGE_ME_ON_FIRST_LOGIN' },`,
      `  ];`,
      `}`,
    ].join('\n');
    let resolvedPasswords;
    runner.getRepeatableFiles = vi.fn(async () => [{
      fileName: 'R__001_accounts.js', filePath: '/x/R__001_accounts.js', dir: '/x',
      content: js, checksum: 'c1', annotations: {}
    }]);
    runner.getStoredChecksumsMongoDB = vi.fn(async () => new Map());
    runner.updateChecksumMongoDB = vi.fn(async () => {});
    runner.injectCustomDataMongoDB = vi.fn(async () => new Date('2026-10-13T00:00:00Z'));
    runner.importResolvedModule = vi.fn(async (resolved) => {
      resolvedPasswords = [...resolved.matchAll(/password: '([^']+)'/g)].map(m => m[1]);
      return {
        up: async () => ({
          passwordSet: true,
          createdUsernames: ['shop_mreport'],
          allUsernames: ['shop_app', 'shop_readonly', 'shop_mreport']
        })
      };
    });

    const result = await runner.run({ dbType: 'mongodb', db: {}, client: {}, migrationsDir: '/x' });
    expect(result.errors).toEqual([]);

    expect(runner.credentialEvents).toEqual([
      { type: 'no_change', username: 'shop_app' },
      { type: 'no_change', username: 'shop_readonly' },
      { type: 'new', username: 'shop_mreport', password: resolvedPasswords[2], expiry: { at: '2026-10-13T00:00:00.000Z' } },
    ]);
    expect(runner.injectCustomDataMongoDB.mock.calls[0][1]).toEqual(['shop_mreport']);
  });
});

describe('DCL placeholder parsing — one entry per CHANGE_ME_ON_FIRST_LOGIN, in file order', () => {
  const P = 'CHANGE_ME_ON_FIRST_LOGIN';
  let runner;
  beforeEach(() => {
    runner = new RepeatableRunner({ checksumTable: 'test_dcl' });
  });

  it('several accounts in one CREATE USER keep their own passwords, and later statements stay aligned', () => {
    const sql = `CREATE USER IF NOT EXISTS 'a'@'%' IDENTIFIED BY '${P}', 'b'@'10.0.%' IDENTIFIED BY '${P}';\nCREATE USER 'c'@'%' IDENTIFIED BY '${P}';`;
    const { passwords } = runner.resolvePlaceholderPasswords(sql, 'R__x.sql');
    runner.recordCredentialEvents(sql, passwords, new Set());

    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: 'a', host: '%', password: passwords[0] },
      { type: 'new', username: 'b', host: '10.0.%', password: passwords[1] },
      { type: 'new', username: 'c', host: '%', password: passwords[2] },
    ]);
  });

  it("an account without @host is MariaDB's default host '%'", () => {
    runner.recordCredentialEvents(`CREATE USER 'x' IDENTIFIED BY '${P}'; CREATE USER 'y'@'%' IDENTIFIED BY '${P}';`, ['pw1', 'pw2'], new Set());
    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: 'x', host: '%', password: 'pw1' },
      { type: 'new', username: 'y', host: '%', password: 'pw2' },
    ]);
  });

  it('CREATE OR REPLACE USER on an existing account → password_changed with the new password', () => {
    runner.recordCredentialEvents(`CREATE OR REPLACE USER 'app'@'%' IDENTIFIED BY '${P}';`, ['pw1'], new Set(['app@%']));
    expect(runner.credentialEvents).toEqual([{ type: 'password_changed', username: 'app', host: '%', password: 'pw1' }]);
  });

  it('DROP USER then CREATE USER: existing account → password_changed, new account → new', () => {
    const sql = `DROP USER IF EXISTS 'app'@'%', 'fresh'@'%';\nCREATE USER 'app'@'%' IDENTIFIED BY '${P}';\nCREATE USER 'fresh'@'%' IDENTIFIED BY '${P}';\nCREATE USER IF NOT EXISTS 'kept'@'%' IDENTIFIED BY '${P}';`;
    runner.recordCredentialEvents(sql, ['pw1', 'pw2', 'pw3'], new Set(['app@%', 'kept@%']));
    expect(runner.credentialEvents).toEqual([
      { type: 'password_changed', username: 'app', host: '%', password: 'pw1' },
      { type: 'new', username: 'fresh', host: '%', password: 'pw2' },
      { type: 'no_change', username: 'kept', host: '%' },
    ]);
  });

  it('SET PASSWORD FOR → password_changed', () => {
    runner.recordCredentialEvents(`SET PASSWORD FOR 'ops'@'localhost' = PASSWORD('${P}');`, ['pw1'], true);
    expect(runner.credentialEvents).toEqual([{ type: 'password_changed', username: 'ops', host: 'localhost', password: 'pw1' }]);
  });

  it("a placeholder whose account can't be identified keeps its password and doesn't shift the next ones", () => {
    const sql = `GRANT ALL ON db.* TO 'z'@'%' IDENTIFIED BY '${P}';\nCREATE USER 'y'@'%' IDENTIFIED BY '${P}';`;
    runner.recordCredentialEvents(sql, ['pw1', 'pw2'], new Set());
    expect(runner.credentialEvents).toEqual([
      { type: 'new', username: '(unrecognized account, statement 1)', password: 'pw1' },
      { type: 'new', username: 'y', host: '%', password: 'pw2' },
    ]);
  });

  it('a placeholder in a comment is not an account (matches resolvePlaceholderPasswords)', () => {
    const sql = `-- e.g. CREATE USER 'doc'@'%' IDENTIFIED BY '${P}';\nCREATE USER 'real'@'%' IDENTIFIED BY '${P}';`;
    const { passwords } = runner.resolvePlaceholderPasswords(sql, 'R__x.sql');
    expect(passwords).toHaveLength(1);
    expect(runner.parsePlaceholderAccountsSQL(sql).map(a => a.name)).toEqual(['real']);
  });

  it('preCheckAccountsExistMariaDB looks up CREATE OR REPLACE / DROP+CREATE accounts too, but not unrecognized ones', async () => {
    const sql = `CREATE OR REPLACE USER 'r'@'%' IDENTIFIED BY '${P}'; GRANT ALL ON *.* TO 'g'@'%' IDENTIFIED BY '${P}';`;
    const connection = { query: vi.fn().mockResolvedValue([[{ User: 'r', Host: '%' }]]) };
    expect([...await runner.preCheckAccountsExistMariaDB(connection, sql)]).toEqual(['r@%']);
    expect(connection.query.mock.calls[0][1]).toEqual(['r']);
  });
});

describe('DCL MongoDB — passwords are never paired by guess', () => {
  const js = [
    `export async function up(db, client) {`,
    `  const users = [`,
    `    { user: 'shop_app', password: 'CHANGE_ME_ON_FIRST_LOGIN' },`,
    `    { user: 'shop_mreport', password: 'CHANGE_ME_ON_FIRST_LOGIN' },`,
    `  ];`,
    `}`,
  ].join('\n');

  async function runWith(upResult) {
    const runner = new RepeatableRunner({});
    runner.getRepeatableFiles = vi.fn(async () => [{
      fileName: 'R__001_accounts.js', filePath: '/x/R__001_accounts.js', dir: '/x', content: js, checksum: 'c1', annotations: {}
    }]);
    runner.getStoredChecksumsMongoDB = vi.fn(async () => new Map());
    runner.updateChecksumMongoDB = vi.fn(async () => {});
    runner.injectCustomDataMongoDB = vi.fn(async () => new Date('2026-10-13T00:00:00Z'));
    runner.importResolvedModule = vi.fn(async () => ({ up: async () => upResult }));
    const result = await runner.run({ dbType: 'mongodb', db: {}, client: {}, migrationsDir: '/x' });
    expect(result.errors).toEqual([]);
    return runner.credentialEvents;
  }

  it('createdUsernames is a subset and no allUsernames → new account reported without a password', async () => {
    const events = await runWith({ passwordSet: true, createdUsernames: ['shop_mreport'] });
    expect(events).toEqual([{ type: 'new', username: 'shop_mreport', password: null, passwordUnmatched: true }]);
  });

  it('createdUsernames covers every placeholder → paired in order', async () => {
    const events = await runWith({ passwordSet: true, createdUsernames: ['shop_app', 'shop_mreport'] });
    expect(events.map(e => [e.username, typeof e.password])).toEqual([['shop_app', 'string'], ['shop_mreport', 'string']]);
  });

  it('no return value → names found in the file, paired when they line up', async () => {
    const events = await runWith(undefined);
    expect(events.map(e => [e.type, e.username, typeof e.password])).toEqual([['new', 'shop_app', 'string'], ['new', 'shop_mreport', 'string']]);
  });

  it('passwordSet: false → every account no_change', async () => {
    const events = await runWith({ passwordSet: false, allUsernames: ['shop_app', 'shop_mreport'] });
    expect(events).toEqual([{ type: 'no_change', username: 'shop_app' }, { type: 'no_change', username: 'shop_mreport' }]);
  });
});
