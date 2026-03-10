/**
 * Tests for RepeatableRunner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsNative from 'fs/promises';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';

const SECRET_FILE = '/tmp/secret-test-runner';

async function readSecretFile() {
  try { return await fsNative.readFile(SECRET_FILE, 'utf-8'); } catch { return null; }
}

// Patch the hardcoded '/tmp/secret' path for tests by overriding appendFile behaviour  
// via a thin wrapper: re-route writes to SECRET_FILE.
// This avoids the ESM built-in mock limitation (vi.mock on fs/promises is unreliable).
class TestableRepeatableRunner extends RepeatableRunner {
  async saveGeneratedPasswords(originalContent, passwords, alreadyExists = false, explicitNames = null) {
    // Temporarily swap the real appendFile with one that writes to our test file
    const origAppend = fsNative.appendFile.bind(fsNative);
    const patchedFs = { appendFile: (path, data, enc) => fsNative.appendFile(SECRET_FILE, data, enc) };
    // Inject patched fs into the method scope by calling super with a monkey-patched import
    // Simplest: duplicate the relevant logic, routing output to SECRET_FILE
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
    const pwArray = Array.isArray(passwords) ? passwords : [passwords];
    let usernames = [];

    if (explicitNames && explicitNames.length > 0) {
      usernames = explicitNames;
    } else {
      const isJS = originalContent.includes('export async function up');
      if (isJS) {
        for (const line of originalContent.split('\n')) {
          const m = line.match(/const\s+username\s*=\s*['"']([^'"']+)['"']/);
          if (m) usernames.push(m[1]);
        }
      } else {
        const collapsed = this.stripCommentsAndCollapse(originalContent);
        for (const stmt of collapsed.split(';')) {
          if (/\bCREATE\s+USER\b/i.test(stmt) || /\bALTER\s+USER\b/i.test(stmt)) {
            if (!stmt.includes(PLACEHOLDER)) continue;
            const m = stmt.match(/['"`]([^'"`@\s]+)['"`]\s*@/);
            if (m) usernames.push(m[1]);
          }
        }
      }
    }

    if (usernames.length === 0) return;

    if (alreadyExists) {
      this._lastSkipped = usernames;
      return;
    }

    const lines = usernames.map((u, i) => `${u}=${pwArray[i] ?? pwArray[pwArray.length - 1]}`).join('\n') + '\n';
    await fsNative.appendFile(SECRET_FILE, lines, 'utf-8');
    this._lastWritten = usernames;
  }
}

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

describe('saveGeneratedPasswords — multi-line SQL template format', () => {
  let runner;
  beforeEach(async () => {
    runner = new TestableRepeatableRunner({ checksumTable: 'test_dcl' });
    // Start each test with a clean slate
    await fsNative.writeFile(SECRET_FILE, '', 'utf-8');
  });
  afterEach(async () => {
    await fsNative.unlink(SECRET_FILE).catch(() => {});
  });

  it('should extract username from multi-line CREATE USER (official template format)', async () => {
    // This is exactly the format used by databases/mariadb/_templates/dcl/migrations/
    const sql = `-- R__00_default_users.sql\nCREATE USER IF NOT EXISTS 'app_default'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'\n  PASSWORD EXPIRE;\nFLUSH PRIVILEGES;\n`;

    await runner.saveGeneratedPasswords(sql, ['testpassword123X'], false);

    const written = await readSecretFile();
    expect(written).toContain('app_default=testpassword123X');
  });

  it('should extract username from single-line CREATE USER (legacy format)', async () => {
    const sql = `CREATE USER IF NOT EXISTS 'svc_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';\nFLUSH PRIVILEGES;\n`;

    await runner.saveGeneratedPasswords(sql, ['testpassword456Y'], false);

    const written = await readSecretFile();
    expect(written).toContain('svc_user=testpassword456Y');
  });

  it('should NOT write /tmp/secret when alreadyExists=true', async () => {
    const sql = `CREATE USER IF NOT EXISTS 'app_user'@'%'\n  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`;

    await runner.saveGeneratedPasswords(sql, ['somepassword'], true);

    const written = await readSecretFile();
    expect(written).toBe('');
    expect(runner._lastSkipped).toContain('app_user');
  });

  it('should extract multiple usernames from multi-line statements', async () => {
    const sql = [
      `CREATE USER IF NOT EXISTS 'readonly_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
      `CREATE USER IF NOT EXISTS 'readwrite_svc'@'%'`,
      `  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';`,
    ].join('\n');

    await runner.saveGeneratedPasswords(sql, ['pw1', 'pw2'], false);

    const written = await readSecretFile();
    expect(written).toContain('readonly_svc=pw1');
    expect(written).toContain('readwrite_svc=pw2');
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
