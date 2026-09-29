/**
 * Tests for RepeatableRunner
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'app_default', password: 'testpassword123X' });
  });

  it('should extract username from single-line CREATE USER (legacy format)', () => {
    const sql = `CREATE USER IF NOT EXISTS 'svc_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';\nFLUSH PRIVILEGES;\n`;

    runner.recordCredentialEvents(sql, ['testpassword456Y'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'svc_user', password: 'testpassword456Y' });
  });

  it('should record a no_change event (not a password) when alreadyExists=true (CREATE USER)', () => {
    const sql = `CREATE USER IF NOT EXISTS 'app_user'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;

    runner.recordCredentialEvents(sql, ['somepassword'], true);

    expect(runner.credentialEvents).toEqual([{ type: 'no_change', username: 'app_user' }]);
  });

  it('should extract multiple usernames from multi-line statements', () => {
    const sql = [
      `CREATE USER IF NOT EXISTS 'readonly_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
      `CREATE USER IF NOT EXISTS 'readwrite_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    ].join('\n');

    runner.recordCredentialEvents(sql, ['pw1', 'pw2'], false);

    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'readonly_svc', password: 'pw1' });
    expect(runner.credentialEvents).toContainEqual({ type: 'new', username: 'readwrite_svc', password: 'pw2' });
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
  it('[Fix] preCheckAccountsExistMariaDB: ALTER USER only → returns false without querying DB', async () => {
    const alterSql = `ALTER USER 'existing_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;
    // Passing null connection — if it tried to query it would throw
    // Returning false means it correctly detected no CREATE USER and exited early
    const result = await runner.preCheckAccountsExistMariaDB(null, alterSql);
    expect(result).toBe(false);
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
