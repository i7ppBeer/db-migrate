/**
 * Repeatable Migration Runner
 * Handles DCL (Data Control Language) migrations using checksum-based execution
 * 
 * Repeatable migrations:
 * - File naming: R__*.sql or R__*.js
 * - No down migration required
 * - Re-executes when checksum changes
 * - Must be idempotent
 * 
 * Supported Annotations:
 * - @allow-dangerous: true/false - Allow dangerous operations
 * - @allow-forbidden: true/false - Allow forbidden operations (requires approval)
 * - @allow: CODE1,CODE2 - Allow specific operation codes
 * 
 * Stored Procedure Support:
 * - Supports DELIMITER statements for MariaDB stored procedures/functions
 * - Example: DELIMITER // ... CREATE PROCEDURE ... // DELIMITER ;
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { maskComments } from './source-scan.js';
import { listMigrationFiles } from './migration-dirs.js';
import { addColumnIfMissing } from './sql-columns.js';

/**
 * Built-in helpers passed as the third argument to MongoDB DCL up(db, client, helpers).
 * Migrations can destructure what they need without any imports:
 *   export async function up(db, client, { createOrUpdateUser }) { ... }
 */
export const mongodbHelpers = {
  /**
   * Create or update a MongoDB user idempotently.
   * - User exists : update roles and password
   * - User absent : create with pwd + roles
   */
  async createOrUpdateUser(adminDb, userSpec) {
    const result = await adminDb.command({ usersInfo: userSpec.user });
    if (result.users.length > 0) {
      await adminDb.command({
        updateUser: userSpec.user,
        pwd: userSpec.pwd,
        roles: userSpec.roles
      });
    } else {
      await adminDb.command({
        createUser: userSpec.user,
        pwd: userSpec.pwd,
        roles: userSpec.roles
      });
    }
  }
};

export class RepeatableRunner {
  constructor(config) {
    this.config = config;
    const tableName = config.checksumTable || 'repeatable_migrations';
    // Validate table name to prevent SQL injection
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
      throw new Error(`Invalid checksum table name: ${tableName}. Must be a valid identifier (letters, digits, underscores).`);
    }
    this.checksumTable = tableName;
    // Credential events (new/rotated/no-change) recorded during this run,
    // for the caller to render into the run's notification email —
    // generated passwords are never written to disk by this class, see
    // recordCredentialEvents() and docs/DCL-PASSWORD.md.
    this.credentialEvents = [];
  }

  /**
   * Calculate SHA-256 checksum of file content
   * @param {string} content - File content
   * @returns {string} - SHA-256 hash
   */
  calculateChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Get all repeatable migration files
   * @param {string|string[]} migrationsDir - Migrations directory, or several (merged by file name, see migration-dirs.js)
   * @returns {Promise<Array<{fileName: string, filePath: string, content: string, checksum: string, annotations: Object}>>}
   */
  async getRepeatableFiles(migrationsDir) {
    const repeatableFiles = await listMigrationFiles(migrationsDir,
      f => f.startsWith('R__') && (f.endsWith('.sql') || f.endsWith('.js')));

    const result = [];
    for (const { fileName, filePath, dir } of repeatableFiles) {
      const content = await fs.readFile(filePath, 'utf-8');
      const checksum = this.calculateChecksum(content);
      const annotations = this.parseFileAnnotations(content, fileName);
      result.push({ fileName, filePath, dir, content, checksum, annotations });
    }

    return result;
  }

  /**
   * Parse file annotations from content
   * Supports both SQL (-- @annotation) and JS (// @annotation) style comments
   * 
   * @param {string} content - File content
   * @param {string} fileName - File name (to detect type)
   * @returns {Object} - Parsed annotations
   */
  parseFileAnnotations(content, fileName) {
    const annotations = {
      allowDangerous: false,
      allowForbidden: false,
      allowedCodes: [],
      description: '',
      type: 'unknown',
      expectFail: false
    };

    const isSQL = fileName.endsWith('.sql');
    const commentPrefix = isSQL ? '--' : '//';
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Stop parsing annotations when we hit non-comment content
      if (!trimmedLine.startsWith(commentPrefix) && trimmedLine !== '' && !trimmedLine.startsWith('/*')) {
        break;
      }

      // Parse @allow-dangerous
      const allowDangerousMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@allow-dangerous\\s*:\\s*(.+)`, 'i'));
      if (allowDangerousMatch) {
        const value = allowDangerousMatch[1].trim().toLowerCase();
        annotations.allowDangerous = ['true', 'yes', '1'].includes(value);
      }

      // Parse @allow-forbidden
      const allowForbiddenMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@allow-forbidden\\s*:\\s*(.+)`, 'i'));
      if (allowForbiddenMatch) {
        const value = allowForbiddenMatch[1].trim().toLowerCase();
        annotations.allowForbidden = ['true', 'yes', '1'].includes(value);
      }

      // Parse @allow (specific codes)
      const allowMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@allow\\s*:\\s*(.+)`, 'i'));
      if (allowMatch) {
        const codes = allowMatch[1].split(',').map(c => c.trim().toUpperCase());
        annotations.allowedCodes = [...annotations.allowedCodes, ...codes];
      }

      // Parse @description
      const descMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@description\\s*:\\s*(.+)`, 'i'));
      if (descMatch) {
        annotations.description = descMatch[1].trim();
      }

      // Parse @type
      const typeMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@type\\s*:\\s*(.+)`, 'i'));
      if (typeMatch) {
        annotations.type = typeMatch[1].trim().toLowerCase();
      }

      // Parse @expect-fail — test-only marker: this migration is intentionally
      // non-idempotent, so test-all should report NOT IDEMPOTENT as a pass.
      const expectFailMatch = trimmedLine.match(new RegExp(`${commentPrefix}\\s*@expect-fail\\s*:\\s*(.+)`, 'i'));
      if (expectFailMatch) {
        const value = expectFailMatch[1].trim().toLowerCase();
        annotations.expectFail = ['true', 'yes', '1'].includes(value);
      }
    }

    return annotations;
  }

  /**
   * Generate a cryptographically random password.
   *
   * Character sets and length are configurable via environment variables:
   *   DDL_MIGRATE_PASSWORD_LENGTH   - total length            (default: 16, min: 8)
   *   DDL_MIGRATE_PASSWORD_SPECIAL  - special character set   (default: "-~")
   *   DDL_MIGRATE_PASSWORD_LOWER    - lowercase character set (default: "abcdefghijklmnopqrstuvwxyz")
   *   DDL_MIGRATE_PASSWORD_UPPER    - uppercase character set (default: "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
   *   DDL_MIGRATE_PASSWORD_DIGITS   - digit character set     (default: "0123456789")
   *
   * The default special chars (-~) are safe across ALL of:
   *   - MySQL / MariaDB CLI   (mysql -p'...')
   *   - mongosh CLI           (--password '...')
   *   - MongoDB URI           mongodb://user:PWD@host  (no percent-encode needed)
   *   - Bash single & double quotes
   *   - ProxySQL config files
   *
   * Guarantees per password: ≥2 lower, ≥2 upper, ≥2 digit, 1-2 special.
   *
   * @returns {string} password of configured length
   */
  generateSecurePassword() {
    // --- Resolve character sets from env vars (fall back to safe defaults) ---
    // Rule: if env var is NOT set → use default silently
    //       if env var IS set but empty → throw (explicit misconfiguration)
    const resolveCharset = (envKey, defaultVal) => {
      if (process.env[envKey] === undefined) return defaultVal;
      const v = process.env[envKey].trim();
      if (!v) throw new Error(`[${envKey}] is set but empty — provide at least one character or unset it`);
      return v;
    };
    const lower   = resolveCharset('DDL_MIGRATE_PASSWORD_LOWER',   'abcdefghijklmnopqrstuvwxyz');
    const upper   = resolveCharset('DDL_MIGRATE_PASSWORD_UPPER',   'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const digits  = resolveCharset('DDL_MIGRATE_PASSWORD_DIGITS',  '0123456789');
    const special = resolveCharset('DDL_MIGRATE_PASSWORD_SPECIAL', '-~');

    // --- Resolve password length (minimum 8 to keep guarantee slots sensible) ---
    const rawLength = parseInt(process.env.DDL_MIGRATE_PASSWORD_LENGTH || '16', 10);
    const length = (!isNaN(rawLength) && rawLength >= 8) ? rawLength : 16;

    const pick = (charset, n) => {
      const bytes = crypto.randomBytes(n);
      return Array.from(bytes).map(b => charset[b % charset.length]);
    };

    // Guaranteed slots: 2 lower + 2 upper + 2 digit + 1 special = 7 (or 8 with bonus special)
    const required = [
      ...pick(lower,   2),
      ...pick(upper,   2),
      ...pick(digits,  2),
      ...pick(special, 1),
    ];
    // 50% chance of a second special char → 1 or 2 specials total
    if (crypto.randomInt(2)) required.push(...pick(special, 1));

    // Pad remaining slots with alphanumeric only
    const alphaNum  = lower + upper + digits;
    const remaining = length - required.length;
    const all = [...required, ...(remaining > 0 ? pick(alphaNum, remaining) : [])];

    // Fisher-Yates shuffle using crypto random
    for (let i = all.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.join('');
  }

  /**
   * Replace every occurrence of CHANGE_ME_ON_FIRST_LOGIN with an independently
   * generated secure password — one unique password per occurrence.
   *
   * Rules:
   *   - Original file on disk is NEVER modified.
   *   - Checksum must be computed BEFORE calling this (from the raw on-disk content).
   *   - Passwords are NOT printed to stdout; they are recorded on
   *     this.credentialEvents for the caller to render into the run's
   *     notification email (see recordCredentialEvents() below).
   *
   * @param {string} content  - Raw file content (may contain placeholder)
   * @param {string} fileName - File name used in log output
   * @returns {{ resolved: string, generated: boolean, passwords: string[]|null }}
   */
  resolvePlaceholderPasswords(content, fileName) {
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
    // Only occurrences outside comments are real credentials. A placeholder
    // mentioned in a comment (every official template has one) must not get
    // a password of its own, or recordCredentialEvents() — which pairs
    // usernames to passwords positionally, ignoring comments — would hand
    // out the comment's password instead of the one actually executed.
    const masked = this.maskComments(content, this.detectLanguage(content, fileName));
    const positions = [];
    for (let i = masked.indexOf(PLACEHOLDER); i !== -1; i = masked.indexOf(PLACEHOLDER, i + PLACEHOLDER.length)) {
      positions.push(i);
    }
    if (positions.length === 0) {
      return { resolved: content, generated: false, passwords: null };
    }

    const passwords = [];
    let resolved = '';
    let cursor = 0;
    for (const pos of positions) {
      const pw = this.generateSecurePassword();
      passwords.push(pw);
      resolved += content.slice(cursor, pos) + pw;
      cursor = pos + PLACEHOLDER.length;
    }
    resolved += content.slice(cursor);

    // Detect whether this is a reset-password (ALTER USER) or new account (CREATE USER)
    const isReset = /\bALTER\s+USER\b/i.test(content) && !/\bCREATE\s+USER\b/i.test(content);
    if (isReset) {
      console.log(`  🔄 [DCL] Reset password detected in: ${fileName} — generating temporary credential (not logged)`);
    } else {
      console.log(`  🔍 [DCL] CHANGE_ME_ON_FIRST_LOGIN detected in: ${fileName} — generating temporary credential (not logged)`);
    }

    return { resolved, generated: true, passwords }
  }

  /**
   * Strip SQL single-line comments and collapse whitespace to a single space.
   * Unlike normalizeSQL(), this intentionally keeps string literal values intact
   * so that CHANGE_ME_ON_FIRST_LOGIN (which appears inside IDENTIFIED BY '…')
   * is still detectable after normalization.
   *
   * @param {string} sql - Raw SQL content
   * @returns {string} - Comment-free, whitespace-collapsed SQL
   */
  stripCommentsAndCollapse(sql) {
    if (!sql) return '';
    return this.maskComments(sql, 'sql')
      // Collapse all whitespace (including newlines) to a single space
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 'js' for MongoDB migration files, 'sql' otherwise. Falls back to sniffing
   * the content when no file name is available (recordCredentialEvents()).
   */
  detectLanguage(content, fileName) {
    if (fileName) return /\.[cm]?js$/i.test(fileName) ? 'js' : 'sql';
    return content.includes('export async function up') ? 'js' : 'sql';
  }

  /** See maskComments() in src/core/source-scan.js. */
  maskComments(content, lang) {
    return maskComments(content, lang);
  }

  /**
   * Parse CREATE USER / ALTER USER lines that contained CHANGE_ME_ON_FIRST_LOGIN
   * and push one credential event per username onto this.credentialEvents —
   * the caller (the `dcl` CLI command) merges these with the account/permission
   * diff and renders the run's notification email (reporter.js). Nothing is
   * written to disk here: a generated password exists only in memory and in
   * that email, never in a file this process leaves behind.
   *
   * Each username is paired with its positionally-matching password:
   *   usernames[0] → passwords[0], usernames[1] → passwords[1], …
   *
   * Each account is classified on its own: an ALTER USER (reset) is always
   * `password_changed`; a CREATE that replaces an account (CREATE OR REPLACE,
   * or DROP + CREATE) is `password_changed` if it already existed; any other
   * CREATE is `no_change` when the account already existed before the file
   * ran (IF NOT EXISTS left its password alone), `new` when it didn't.
   *
   * With `requireAligned`, the accounts must line up one-to-one with the
   * passwords (the MongoDB paths, where the names come from the migration's
   * return value or a regex): when they don't, no password is paired at all —
   * each account is reported with `passwordUnmatched` instead of possibly
   * someone else's password.
   *
   * @param {string}          originalContent  - Raw (un-resolved) SQL or JS
   * @param {string|string[]} passwords        - Generated password(s) in occurrence order
   * @param {boolean|Set<string>} existing     - Which accounts already existed: a Set of
   *                                             names / 'name@host' keys (see accountKey()),
   *                                             or a boolean for every account in the file
   * @param {string[]}        [explicitNames]  - Usernames from up() return value (overrides regex)
   * @param {{requireAligned?: boolean}} [opts]
   */
  recordCredentialEvents(originalContent, passwords, existing = false, explicitNames = null, { requireAligned = false } = {}) {
    const pwArray = Array.isArray(passwords) ? passwords : [passwords];
    let usernames = [];

    if (explicitNames && explicitNames.length > 0) {
      // Trust what the migration explicitly reported
      usernames = explicitNames;
    } else {
      const isJS = originalContent.includes('export async function up');
      if (isJS) {
        // JS: scan line by line for:
        //   const username = 'app_xxx';   (single-var style)
        //   user: 'app_xxx',              (object property style)
        // Comments masked out so a commented-out user isn't paired with a
        // password (resolvePlaceholderPasswords() ignores comments too).
        for (const line of this.maskComments(originalContent, 'js').split('\n')) {
          const m = line.match(/const\s+username\s*=\s*['"']([^'"']+)['"']/) ||
                    line.match(/\buser\s*:\s*['"]([^'"]+)['"]/);
          if (m) usernames.push(m[1]);
        }
      } else {
        usernames = this.parsePlaceholderAccountsSQL(originalContent);
      }
    }

    const accounts = usernames.map(u => (typeof u === 'string' ? { name: u } : u));
    if (accounts.length === 0) return;
    const aligned = !requireAligned || accounts.length === pwArray.length;
    if (!aligned) {
      console.log(`  ⚠️  [DCL] ${accounts.length} account(s) but ${pwArray.length} generated password(s) — can't tell which password belongs to which account, so none is reported. Return allUsernames from up(), listing every CHANGE_ME_ON_FIRST_LOGIN account in file order.`);
    }

    // host is only known for SQL (MariaDB 'user'@'host'); left off otherwise
    const identity = (a) => (a.host ? { username: a.name, host: a.host } : { username: a.name });
    const existed = (a) => existing === true ||
      (existing instanceof Set && existing.has(RepeatableRunner.accountKey(a.name, a.host)));

    const created = [], unchanged = [], rotated = [];
    accounts.forEach((a, i) => {
      if (!a.name) {
        // A placeholder whose account couldn't be identified: the password was
        // still set somewhere, so hand it out rather than lose it
        this.credentialEvents.push({ type: 'new', username: `(unrecognized account, statement ${a.statement + 1})`, password: pwArray[i] });
        console.log(`  ⚠️  [DCL] CHANGE_ME_ON_FIRST_LOGIN in statement ${a.statement + 1} doesn't belong to a recognizable CREATE USER / ALTER USER account — its password is in the email, unlabeled`);
        return;
      }
      const wasThere = existed(a);
      // CREATE USER IF NOT EXISTS on an account that already existed leaves
      // its password alone, so there is nothing to hand out
      if (!a.isReset && !a.replaces && wasThere) {
        this.credentialEvents.push({ type: 'no_change', ...identity(a) });
        unchanged.push(a.name);
        return;
      }
      const changed = a.isReset || (a.replaces && wasThere);
      const event = { type: changed ? 'password_changed' : 'new', ...identity(a) };
      if (aligned) {
        // Pair accounts[i] → pwArray[i]; fall back to last password if arrays diverge
        event.password = pwArray[i] ?? pwArray[pwArray.length - 1];
        if (a.expiresOnFirstLogin) event.expiry = { onFirstLogin: true };
      } else {
        event.password = null;
        event.passwordUnmatched = true;
      }
      this.credentialEvents.push(event);
      (changed ? rotated : created).push(a.name);
    });

    if (unchanged.length) console.log(`  ⚠️  [DCL] Account already existed — password NOT changed: ${unchanged.join(', ')}`);
    if (rotated.length) console.log(`  🔄 [DCL] Password rotated for: ${rotated.join(', ')} (included in the run's notification email, not logged here)`);
    if (created.length) console.log(`  🆕 [DCL] New account created: ${created.join(', ')} (included in the run's notification email, not logged here)`);
  }

  /**
   * Key identifying one account in an "already existed" Set: 'name@host'
   * (host lower-cased — MariaDB host names are case-insensitive) when the
   * host is known, else the bare name (MongoDB).
   */
  static accountKey(name, host) {
    return host ? `${name}@${String(host).toLowerCase()}` : name;
  }

  /**
   * One entry per CHANGE_ME_ON_FIRST_LOGIN occurrence (outside comments), in
   * file order — exactly the order resolvePlaceholderPasswords() generates
   * the passwords in, so entry i always pairs with password i.
   *
   * Each placeholder belongs to the nearest account named before it in its
   * statement, so several accounts in one statement work:
   *   CREATE USER 'a'@'%' IDENTIFIED BY 'CHANGE_ME…', 'b'@'%' IDENTIFIED BY 'CHANGE_ME…';
   * An account without @host is MariaDB's default host '%'.
   *
   *   isReset   ALTER USER / SET PASSWORD — always sets a new password
   *   replaces  CREATE OR REPLACE USER, or CREATE USER after a DROP USER of the
   *             same account earlier in the file — sets the password even when
   *             the account already existed
   *
   * A placeholder whose account can't be identified (another statement type,
   * unquoted user name) still gets an entry, with name null, so the pairing of
   * every later placeholder stays right.
   *
   * @param {string} originalContent - Raw (un-resolved) SQL
   * @returns {Array<{name: ?string, host?: string, isReset?: boolean, replaces?: boolean,
   *                  expiresOnFirstLogin?: boolean, statement: number}>}
   */
  parsePlaceholderAccountsSQL(originalContent) {
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
    // An account spec: 'user' optionally @'host' / @host, right after USER
    // [IF [NOT] EXISTS], FOR (SET PASSWORD FOR) or a comma (next account)
    const SPEC = /(?:\bUSER(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|\bFOR|,)\s*(['"`])([^'"`]+)\1(?:\s*@\s*(?:(['"`])([^'"`]*)\3|([^\s,;'"`=]+)))?/gi;
    const specs = (text) => [...text.matchAll(SPEC)].map(m => ({ name: m[2], host: m[4] ?? m[5] ?? '%' }));
    const key = (a) => RepeatableRunner.accountKey(a.name, a.host);

    const accounts = [];
    const dropped = new Set();
    this.stripCommentsAndCollapse(originalContent).split(';').forEach((stmt, statement) => {
      const head = stmt.trimStart();
      if (/^DROP\s+USER\b/i.test(head)) {
        for (const a of specs(stmt)) dropped.add(key(a));
        return;
      }
      const create = /^CREATE\s+(OR\s+REPLACE\s+)?USER\b/i.exec(head);
      const reset = /^(?:ALTER\s+USER|SET\s+PASSWORD)\b/i.test(head);
      // Only a bare PASSWORD EXPIRE forces a change on first login;
      // EXPIRE NEVER / DEFAULT / INTERVAL n DAY don't.
      const expiresOnFirstLogin = /\bPASSWORD\s+EXPIRE\b(?!\s+(?:NEVER|DEFAULT|INTERVAL)\b)/i.test(stmt);

      for (let i = stmt.indexOf(PLACEHOLDER); i !== -1; i = stmt.indexOf(PLACEHOLDER, i + PLACEHOLDER.length)) {
        const owner = (create || reset) ? specs(stmt.slice(0, i)).pop() : undefined;
        if (!owner) {
          accounts.push({ name: null, statement });
          continue;
        }
        accounts.push({
          ...owner,
          isReset: reset,
          replaces: Boolean(create) && (Boolean(create[1]) || dropped.has(key(owner))),
          expiresOnFirstLogin,
          statement
        });
      }
    });
    return accounts;
  }


  /**
   * Inject customData into newly-created MongoDB users.
   *
   * customData fields:
   *   expiresAt             - now + DCL_PASSWORD_EXPIRY_DAYS (default 7)
   *   passwordLastModified  - now
   *   description           - human-readable note
   *
   * @param {Object}   client    - MongoClient
   * @param {string[]} usernames - list of usernames in the admin db
   */
  async injectCustomDataMongoDB(client, usernames, description = 'Auto-created user, requires password change before expiry.') {
    const expiryDays = parseInt(process.env.DCL_PASSWORD_EXPIRY_DAYS ?? '7', 10);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const customData = {
      expiresAt,
      passwordLastModified: now,
      description
    };

    const adminDb = client.db('admin');
    for (const username of usernames) {
      try {
        await adminDb.command({ updateUser: username, customData });
        console.log(`  📋 [DCL] customData injected: ${username} (expires ${expiresAt.toISOString().slice(0, 10)})`);
      } catch (err) {
        console.warn(`  ⚠️  [DCL] customData inject failed for ${username}: ${err.message}`);
      }
    }
    return expiresAt;
  }

  /**
   * Import a MongoDB migration's placeholder-resolved source, which contains
   * plaintext generated passwords. It has to exist as a file for import(), so
   * it goes into a fresh private directory (mkdtemp → 0700, file 0600 — not
   * readable by other users on the host) that is removed as soon as the
   * module has loaded, whether or not the import succeeded.
   *
   * @param {string} resolvedContent - Output of resolvePlaceholderPasswords()
   * @param {string} fileName        - Original file name (for the .mjs name)
   * @returns {Promise<Object>} the imported module
   */
  async importResolvedModule(resolvedContent, fileName) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcl-'));
    try {
      // .mjs so Node treats it as ESM regardless of the temp dir having no package.json
      const tempFilePath = path.join(dir, fileName.replace(/\.js$/, '.mjs'));
      await fs.writeFile(tempFilePath, resolvedContent, { encoding: 'utf-8', mode: 0o600 });
      return await import(`file://${tempFilePath}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Process SQL content with DELIMITER support for stored procedures
   * Returns executable SQL chunks that can be run separately
   * 
   * @param {string} content - SQL content with potential DELIMITER statements
   * @returns {Array<{sql: string, delimiter: string}>} - Array of SQL chunks with their delimiters
   */
  processDelimiterSQL(content) {
    const chunks = [];
    let currentDelimiter = ';';
    let currentChunk = '';
    
    // Check if content uses DELIMITER
    const hasDelimiter = /DELIMITER\s+\S+/i.test(content);
    
    if (!hasDelimiter) {
      // No DELIMITER found, return as single chunk
      return [{ sql: content.trim(), delimiter: ';' }];
    }

    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Check for DELIMITER change
      const delimiterMatch = trimmedLine.match(/^DELIMITER\s+(\S+)\s*$/i);
      if (delimiterMatch) {
        // Save current chunk if not empty
        if (currentChunk.trim()) {
          chunks.push({ sql: currentChunk.trim(), delimiter: currentDelimiter });
          currentChunk = '';
        }
        currentDelimiter = delimiterMatch[1];
        continue;
      }
      
      // Check if line ends with current delimiter
      if (trimmedLine.endsWith(currentDelimiter) && currentDelimiter !== ';') {
        // Remove the delimiter from end and add to chunk
        const sqlPart = line.slice(0, line.lastIndexOf(currentDelimiter));
        currentChunk += sqlPart + '\n';
        chunks.push({ sql: currentChunk.trim(), delimiter: currentDelimiter });
        currentChunk = '';
      } else {
        currentChunk += line + '\n';
      }
    }
    
    // Add remaining chunk
    if (currentChunk.trim()) {
      chunks.push({ sql: currentChunk.trim(), delimiter: currentDelimiter });
    }
    
    // Filter out empty chunks and DELIMITER-only statements
    return chunks.filter(c => 
      c.sql && 
      !c.sql.match(/^DELIMITER\s+\S+\s*$/i) &&
      c.sql.trim() !== ''
    );
  }

  /**
   * Get stored checksums from database (MariaDB)
   * @param {Object} connection - Database connection
   * @returns {Promise<Map<string, {checksum: string, appliedAt: Date}>>}
   */
  async getStoredChecksumsMariaDB(connection, { readOnly = false } = {}) {
    if (readOnly) return this.readStoredChecksumsMariaDB(connection);
    // Ensure checksum table exists
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS ${this.checksumTable} (
        id VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        content MEDIUMTEXT NULL
      )
    `);
    // content: the file as last applied (placeholders, never passwords), so
    // `dcl --plan` can show what changed. Added to tables from before it existed.
    await addColumnIfMissing(connection, { table: this.checksumTable, tableName: this.checksumTable, column: 'content', definition: 'MEDIUMTEXT NULL' });

    // applied_at as a Unix epoch — the driver would read the server-time-zone
    // value as local time (same fix as the DDL changelog, mariadb-adapter status())
    const [rows] = await connection.execute(
      `SELECT id, checksum, applied_at, UNIX_TIMESTAMP(applied_at) AS applied_epoch, content FROM ${this.checksumTable}`
    );

    const checksums = new Map();
    for (const row of rows) {
      checksums.set(row.id, {
        checksum: row.checksum,
        appliedAt: row.applied_epoch != null ? new Date(Number(row.applied_epoch) * 1000) : row.applied_at,
        content: row.content ?? null
      });
    }
    return checksums;
  }

  /**
   * getStoredChecksumsMariaDB() without creating or altering the table — for
   * read-only commands (dcl:status, dcl --plan) run with a SELECT-only
   * account. No table yet means nothing has been applied.
   */
  async readStoredChecksumsMariaDB(connection) {
    const [cols] = await connection.execute(
      'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [this.checksumTable]
    );
    const checksums = new Map();
    if (cols.length === 0) return checksums;
    const hasContent = cols.some(c => String(c.name).toLowerCase() === 'content');
    const [rows] = await connection.execute(
      `SELECT id, checksum, applied_at, UNIX_TIMESTAMP(applied_at) AS applied_epoch, ${hasContent ? 'content' : 'NULL AS content'} FROM ${this.checksumTable}`
    );
    for (const row of rows) {
      checksums.set(row.id, {
        checksum: row.checksum,
        appliedAt: row.applied_epoch != null ? new Date(Number(row.applied_epoch) * 1000) : row.applied_at,
        content: row.content ?? null
      });
    }
    return checksums;
  }

  /**
   * Pre-check which accounts this file creates already exist.
   *
   * Takes the `CREATE USER … CHANGE_ME_ON_FIRST_LOGIN` statements and looks
   * each 'user'@'host' up in `mysql.user` directly. Per account, not per file:
   * a file that adds a new account next to ones created by an earlier run must
   * still hand out the new account's password.
   *
   * Called BEFORE executing the migration SQL so the result is not polluted by
   * stale `SHOW WARNINGS` state left over from earlier queries on the same
   * connection (mysql2 multi-statement mode does not reset the warning buffer
   * when a subsequent query produces zero warnings).
   *
   * ALTER USER (reset) statements are left out — they always target an
   * existing account and always change its password.
   *
   * @param {Object} connection     - mysql2 connection
   * @param {string} originalContent - Raw (un-resolved) SQL content
   * @returns {Promise<Set<string>>} accountKey(user, host) of each account that already exists
   */
  async preCheckAccountsExistMariaDB(connection, originalContent) {
    const creates = this.parsePlaceholderAccountsSQL(originalContent).filter(a => a.name && !a.isReset);
    if (creates.length === 0) return new Set();

    const names = [...new Set(creates.map(a => a.name))];
    const [rows] = await connection.query(
      `SELECT User, Host FROM mysql.user WHERE User IN (${names.map(() => '?').join(', ')})`,
      names
    );
    const present = new Set(rows.map(r => RepeatableRunner.accountKey(String(r.User), String(r.Host))));
    return new Set(
      creates.map(a => RepeatableRunner.accountKey(a.name, a.host)).filter(key => present.has(key))
    );
  }

  /**
   * Get stored checksums from database (MongoDB)
   * @param {Object} db - MongoDB database
   * @returns {Promise<Map<string, {checksum: string, appliedAt: Date}>>}
   */
  async getStoredChecksumsMongoDB(db) {
    const collection = db.collection(this.checksumTable);
    const docs = await collection.find({}).toArray();

    const checksums = new Map();
    for (const doc of docs) {
      checksums.set(doc._id, {
        checksum: doc.checksum,
        appliedAt: doc.appliedAt,
        content: doc.content ?? null
      });
    }
    return checksums;
  }

  /**
   * Update checksum in database (MariaDB)
   * @param {Object} connection - Database connection
   * @param {string} id - Migration ID
   * @param {string} checksum - New checksum
   */
  async updateChecksumMariaDB(connection, id, checksum, content = null) {
    await connection.execute(
      `INSERT INTO ${this.checksumTable} (id, checksum, content) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), content = VALUES(content), applied_at = CURRENT_TIMESTAMP`,
      [id, checksum, content]
    );
  }

  /**
   * Update checksum in database (MongoDB)
   * @param {Object} db - MongoDB database
   * @param {string} id - Migration ID
   * @param {string} checksum - New checksum
   */
  async updateChecksumMongoDB(db, id, checksum, content = null) {
    const collection = db.collection(this.checksumTable);
    await collection.updateOne(
      { _id: id },
      { $set: { checksum, content, appliedAt: new Date() } },
      { upsert: true }
    );
  }

  /**
   * Get status of repeatable migrations
   * @param {Object} context - { connection, db, dbType, migrationsDir }
   * @returns {Promise<{pending: Array, upToDate: Array, total: number}>}
   */
  async status(context) {
    const { dbType, migrationsDir } = context;
    
    const files = await this.getRepeatableFiles(migrationsDir);
    
    let storedChecksums;
    if (dbType === 'mariadb') {
      // status() only reads: never create the checksum table from here
      storedChecksums = await this.getStoredChecksumsMariaDB(context.connection, { readOnly: true });
    } else if (dbType === 'mongodb') {
      storedChecksums = await this.getStoredChecksumsMongoDB(context.db);
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }

    const pending = [];
    const upToDate = [];

    for (const file of files) {
      const stored = storedChecksums.get(file.fileName);
      
      if (!stored || stored.checksum !== file.checksum) {
        pending.push({
          fileName: file.fileName,
          dir: file.dir,
          reason: stored ? 'checksum changed' : 'new file',
          currentChecksum: file.checksum,
          storedChecksum: stored?.checksum || null,
          content: file.content,
          previousContent: stored?.content ?? null
        });
      } else {
        upToDate.push({
          fileName: file.fileName,
          dir: file.dir,
          checksum: file.checksum,
          appliedAt: stored.appliedAt
        });
      }
    }

    // R1 (DCL): a checksum recorded for a file that's no longer on disk —
    // the script was deleted or renamed after being applied, and whatever it
    // created (accounts, grants) is still in the database.
    const onDisk = new Set(files.map(f => f.fileName));
    const orphaned = [...storedChecksums.entries()]
      .filter(([fileName]) => !onDisk.has(fileName))
      .map(([fileName, stored]) => ({ fileName, appliedAt: stored.appliedAt }));

    return {
      pending,
      upToDate,
      orphaned,
      total: files.length
    };
  }

  /**
   * Drop checksum records for files that are gone (see status().orphaned),
   * after someone confirmed the removal was intended (--accept-removed-dcl).
   * Touches only this tool's bookkeeping, never accounts or grants.
   */
  async forgetChecksums(context, fileNames) {
    if (!fileNames.length) return;
    if (context.dbType === 'mariadb') {
      await context.connection.query(`DELETE FROM ${this.checksumTable} WHERE id IN (?)`, [fileNames]);
    } else {
      await context.db.collection(this.checksumTable).deleteMany({ _id: { $in: fileNames } });
    }
  }

  /**
   * Run repeatable migrations (MariaDB)
   * @param {Object} context - { connection, migrationsDir, validator? }
   * @returns {Promise<{applied: Array, errors: Array, skipped: Array}>}
   */
  async runMariaDB(context) {
    const { connection, migrationsDir, validator } = context;
    const result = { applied: [], errors: [], skipped: [], approvals: [] };

    const files = await this.getRepeatableFiles(migrationsDir);
    const storedChecksums = await this.getStoredChecksumsMariaDB(connection);

    for (const file of files) {
      const stored = storedChecksums.get(file.fileName);
      
      // Skip if checksum matches
      if (stored && stored.checksum === file.checksum) {
        continue;
      }

      // Validate with file annotations if validator provided
      if (validator && typeof validator.validateContent === 'function') {
        const validateOptions = {
          allowDangerous: file.annotations.allowDangerous,
          allowForbidden: file.annotations.allowForbidden,
          allowedCodes: file.annotations.allowedCodes,
          approvedBy: context.approvedBy
        };
        
        const validationResult = validator.validateContent(file.content, file.fileName, validateOptions);
        
        if (!validationResult.valid) {
          // Check if blocked due to dangerous/forbidden operations
          const blockedOps = [...(validationResult.forbiddenOps || []), ...(validationResult.dangerousOps || [])];
          if (blockedOps.length > 0) {
            const codes = blockedOps.map(op => op.code).join(', ');
            result.skipped.push({
              fileName: file.fileName,
              reason: `Blocked by validation: ${codes}`,
              hint: `Add annotation to allow: -- @allow-dangerous: true OR -- @allow: ${codes}`
            });
            continue;
          }
          // Other validation errors
          result.errors.push(`${file.fileName}: Validation failed - ${validationResult.errors.map(e => e.message).join('; ')}`);
          break;
        }
        // Forbidden operations this file was allowed to run, and who approved
        // them — for the run log and the notification email
        if (validationResult.approval) {
          for (const code of validationResult.approval.codes) {
            result.approvals.push({ file: file.fileName, code, approvedBy: validationResult.approval.approvedBy });
          }
        }
      }

      try {
        // Resolve CHANGE_ME_ON_FIRST_LOGIN → auto-generated password (in-memory only).
        // Checksum was already computed from the original on-disk content above.
        const { resolved: resolvedContent, generated, passwords } = this.resolvePlaceholderPasswords(file.content, file.fileName);

        // Pre-check account existence BEFORE running SQL.
        // This avoids relying on SHOW WARNINGS, which does not reset its buffer
        // when a subsequent query produces zero warnings (mysql2 multi-statement
        // mode quirk), causing false-positive "already-exists" detection on the
        // very first run when the connection has residual Notes from earlier ops.
        let existingAccounts = new Set();
        if (generated) {
          existingAccounts = await this.preCheckAccountsExistMariaDB(connection, file.content);
        }

        // Process DELIMITER for stored procedures support
        const sqlChunks = this.processDelimiterSQL(resolvedContent);

        for (const chunk of sqlChunks) {
          if (chunk.sql.trim()) {
            await connection.query(chunk.sql);
          }
        }

        // Record generated credentials; `existingAccounts` was determined above
        // via a direct mysql.user query so it is immune to stale SHOW WARNINGS.
        if (generated) {
          this.recordCredentialEvents(file.content, passwords, existingAccounts);
        }

        // Update checksum
        await this.updateChecksumMariaDB(connection, file.fileName, file.checksum, file.content);

        result.applied.push({
          fileName: file.fileName,
          dir: file.dir,
          reason: stored ? 'checksum changed' : 'new file',
          annotations: file.annotations
        });
      } catch (error) {
        result.errors.push(`${file.fileName}: ${error.message}`);
        break; // Stop on first error
      }
    }

    return result;
  }

  /**
   * Run repeatable migrations (MongoDB)
   * @param {Object} context - { db, client, migrationsDir, validator? }
   * @returns {Promise<{applied: Array, errors: Array, skipped: Array}>}
   */
  async runMongoDB(context) {
    const { db, client, migrationsDir, validator } = context;
    const result = { applied: [], errors: [], skipped: [], approvals: [] };

    const files = await this.getRepeatableFiles(migrationsDir);
    const storedChecksums = await this.getStoredChecksumsMongoDB(db);

    for (const file of files) {
      const stored = storedChecksums.get(file.fileName);
      
      // Skip if checksum matches
      if (stored && stored.checksum === file.checksum) {
        continue;
      }

      // Validate with file annotations if validator provided
      if (validator && typeof validator.validateContent === 'function') {
        const validateOptions = {
          allowDangerous: file.annotations.allowDangerous,
          allowForbidden: file.annotations.allowForbidden,
          allowedCodes: file.annotations.allowedCodes,
          approvedBy: context.approvedBy
        };
        
        const validationResult = validator.validateContent(file.content, file.fileName, validateOptions);
        
        if (!validationResult.valid) {
          // Check if blocked due to dangerous/forbidden operations
          const blockedOps = [...(validationResult.forbiddenOps || []), ...(validationResult.dangerousOps || [])];
          if (blockedOps.length > 0) {
            const codes = blockedOps.map(op => op.code).join(', ');
            result.skipped.push({
              fileName: file.fileName,
              reason: `Blocked by validation: ${codes}`,
              hint: `Add annotation to allow: // @allow-dangerous: true OR // @allow: ${codes}`
            });
            continue;
          }
          // Other validation errors
          result.errors.push(`${file.fileName}: Validation failed - ${validationResult.errors.map(e => e.message).join('; ')}`);
          break;
        }
        // Forbidden operations this file was allowed to run, and who approved
        // them — for the run log and the notification email
        if (validationResult.approval) {
          for (const code of validationResult.approval.codes) {
            result.approvals.push({ file: file.fileName, code, approvedBy: validationResult.approval.approvedBy });
          }
        }
      }

      try {
        // Resolve CHANGE_ME_ON_FIRST_LOGIN → auto-generated password (in-memory only).
        // For JS files a temp file is written so the module can be dynamically imported.
        const { resolved: resolvedContent, generated, passwords } = this.resolvePlaceholderPasswords(file.content, file.fileName);

        const moduleToRun = generated
          ? await this.importResolvedModule(resolvedContent, file.fileName)
          : await import(`file://${file.filePath}?t=${Date.now()}`);

        if (typeof moduleToRun.up !== 'function') {
          throw new Error('Migration must export an "up" function');
        }

        const upResult = await moduleToRun.up(db, client, mongodbHelpers);

        // passwordSet: true      → new account
        // passwordSet: false     → already existed, password NOT changed
        // passwordSet: 'rotated' → existing account, password forcibly rotated
        //                          (the MariaDB adapter detects this from ALTER
        //                          USER syntax; MongoDB has no such syntax to
        //                          sniff, so the migration must say so explicitly)
        // undefined              → template does not support return value (treat as unknown)
        const alreadyExists = upResult?.passwordSet === false;
        const isNewAccount  = upResult?.passwordSet === true;
        const isRotated     = upResult?.passwordSet === 'rotated';
        // Migration may explicitly report which usernames were created / managed
        const createdUsernames = upResult?.createdUsernames ?? null;
        const allUsernames     = upResult?.allUsernames ?? createdUsernames;

        // Passwords are generated per CHANGE_ME_ON_FIRST_LOGIN occurrence, in
        // file order, so they pair with allUsernames (every account the file
        // manages, in that order) — not with createdUsernames, which is only
        // the subset this run created. When allUsernames lines up with the
        // passwords, each account is classified on its own: created → new,
        // the rest → no_change.
        //
        // Anything that can't be lined up one-to-one with the passwords is
        // reported without a password (requireAligned) — never with a guess.
        if (generated) {
          const pwCount = Array.isArray(passwords) ? passwords.length : 1;
          const strict = { requireAligned: true };
          const listed = Array.isArray(upResult?.allUsernames) ? upResult.allUsernames : null;
          if (isRotated) {
            // { name, isReset: true } → recorded as password_changed
            this.recordCredentialEvents(file.content, passwords, false, (allUsernames || []).map(name => ({ name, isReset: true })), strict);
          } else if (alreadyExists) {
            // Every account already existed: no password was handed out, so
            // there's nothing to pair (and nothing to warn about)
            this.recordCredentialEvents(file.content, passwords, true, allUsernames);
          } else if (listed && listed.length === pwCount) {
            // Per account when the script says which ones it created; without
            // createdUsernames, every listed account counts as new (as before)
            const existing = Array.isArray(createdUsernames)
              ? new Set(listed.filter(name => !createdUsernames.includes(name)))
              : false;
            this.recordCredentialEvents(file.content, passwords, existing, listed, strict);
          } else {
            // createdUsernames, else allUsernames, else the names found in the
            // file — paired only if they line up with the passwords
            this.recordCredentialEvents(file.content, passwords, false, createdUsernames ?? listed, strict);
          }
        }

        // Inject customData (expiresAt, passwordLastModified) for new or rotated accounts
        if (isNewAccount || isRotated) {
          // Prefer explicitly returned createdUsernames; fall back to regex parse
          let injectTargets = isRotated ? allUsernames : createdUsernames;
          if (!injectTargets) {
            injectTargets = [];
            for (const line of file.content.split('\n')) {
              const m = line.match(/const\s+username\s*=\s*['"]([^'"]+)['"]/);
              if (m) injectTargets.push(m[1]);
            }
          }
          if (injectTargets.length > 0) {
            const expiresAt = await this.injectCustomDataMongoDB(client, injectTargets, isRotated
              ? 'Password rotated, requires password change before expiry.'
              : 'Auto-created user, requires password change before expiry.');
            // Lets the notification email state the real deadline instead of a
            // generic "expires" claim — MongoDB itself does not enforce it.
            const targets = new Set(injectTargets);
            for (const e of this.credentialEvents) {
              if (e.password && targets.has(e.username) && !e.expiry) e.expiry = { at: expiresAt.toISOString() };
            }
          }
        }

        // Update checksum
        await this.updateChecksumMongoDB(db, file.fileName, file.checksum, file.content);

        result.applied.push({
          fileName: file.fileName,
          dir: file.dir,
          reason: stored ? 'checksum changed' : 'new file',
          annotations: file.annotations
        });
      } catch (error) {
        result.errors.push(`${file.fileName}: ${error.message}`);
        break; // Stop on first error
      }
    }

    return result;
  }

  /**
   * Run repeatable migrations (auto-detect type)
   * @param {Object} context - { connection?, db?, client?, dbType, migrationsDir }
   * @returns {Promise<{applied: Array, errors: Array}>}
   */
  async run(context) {
    const { dbType } = context;

    if (dbType === 'mariadb') {
      return this.runMariaDB(context);
    } else if (dbType === 'mongodb') {
      return this.runMongoDB(context);
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  }
}

export default RepeatableRunner;
