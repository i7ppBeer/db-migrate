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
   * @param {string} migrationsDir - Migrations directory
   * @returns {Promise<Array<{fileName: string, filePath: string, content: string, checksum: string, annotations: Object}>>}
   */
  async getRepeatableFiles(migrationsDir) {
    const files = await fs.readdir(migrationsDir);
    const repeatableFiles = files
      .filter(f => f.startsWith('R__') && (f.endsWith('.sql') || f.endsWith('.js')))
      .sort();

    const result = [];
    for (const fileName of repeatableFiles) {
      const filePath = path.join(migrationsDir, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      const checksum = this.calculateChecksum(content);
      const annotations = this.parseFileAnnotations(content, fileName);
      result.push({ fileName, filePath, content, checksum, annotations });
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
      type: 'unknown'
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
   *   - Passwords are NOT printed to stdout; they are saved to /tmp/secret.
   *
   * @param {string} content  - Raw file content (may contain placeholder)
   * @param {string} fileName - File name used in log output
   * @returns {{ resolved: string, generated: boolean, passwords: string[]|null }}
   */
  resolvePlaceholderPasswords(content, fileName) {
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
    if (!content.includes(PLACEHOLDER)) {
      return { resolved: content, generated: false, passwords: null };
    }

    const passwords = [];
    const resolved = content.replace(/CHANGE_ME_ON_FIRST_LOGIN/g, () => {
      const pw = this.generateSecurePassword();
      passwords.push(pw);
      return pw;
    });

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
    return sql
      // Remove single-line comments (-- …) but keep the newline as a space
      .replace(/--[^\n]*/g, ' ')
      // Collapse all whitespace (including newlines) to a single space
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Parse CREATE USER / ALTER USER lines that contained CHANGE_ME_ON_FIRST_LOGIN
   * and append `username=password` entries to /tmp/secret.
   *
   * Each username is paired with its positionally-matching password:
   *   usernames[0] → passwords[0], usernames[1] → passwords[1], …
   *
   * @param {string}          originalContent  - Raw (un-resolved) SQL or JS
   * @param {string|string[]} passwords        - Generated password(s) in occurrence order
   * @param {boolean}         alreadyExists    - True when account already existed
   * @param {string[]}        [explicitNames]  - Usernames from up() return value (overrides regex)
   */
  async saveGeneratedPasswords(originalContent, passwords, alreadyExists = false, explicitNames = null) {
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
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
        for (const line of originalContent.split('\n')) {
          const m = line.match(/const\s+username\s*=\s*['"']([^'"']+)['"']/) ||
                    line.match(/\buser\s*:\s*['"]([^'"]+)['"]/);
          if (m) usernames.push(m[1]);
        }
      } else {
        // SQL: strip comments, collapse whitespace, then split by ';' into statements.
        // This handles multi-line CREATE USER … IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
        // which is the format used by all official templates.
        const collapsed = this.stripCommentsAndCollapse(originalContent);
        for (const stmt of collapsed.split(';')) {
          const isCreate = /\bCREATE\s+USER\b/i.test(stmt);
          const isAlter  = /\bALTER\s+USER\b/i.test(stmt);
          if (!isCreate && !isAlter) continue;
          if (!stmt.includes(PLACEHOLDER)) continue;
          // SQL pattern: 'username'@host  or  `username`@host
          const m = stmt.match(/['"\`]([^'"\`@\s]+)['"\`]\s*@/);
          if (m) usernames.push({ name: m[1], isReset: isAlter && !isCreate });
        }
      }
    }

    // Normalise to plain string list for writing; detect if all entries are resets
    const isResetPwd = usernames.length > 0 && usernames.every(u => u?.isReset);
    const usernameList = usernames.map(u => (typeof u === 'string' ? u : u.name));

    if (usernameList.length === 0) return;

    // CREATE USER: skip if account already existed (password was NOT changed by IF NOT EXISTS)
    // ALTER USER (reset_pwd): always write — ALTER USER unconditionally changes the password
    if (alreadyExists && !isResetPwd) {
      console.log(`  ⚠️  [DCL] Account already existed — password NOT changed. Skipped /tmp/secret: ${usernameList.join(', ')}`);
      return;
    }

    // Pair usernames[i] → pwArray[i]; fall back to last password if arrays diverge
    const lines = usernameList.map((u, i) => `${u}=${pwArray[i] ?? pwArray[pwArray.length - 1]}`).join('\n') + '\n';
    await fs.appendFile('/tmp/secret', lines, 'utf-8');
    if (isResetPwd) {
      console.log(`  🔄 [DCL] Reset password applied — temporary credential saved to /tmp/secret: ${usernameList.join(', ')} (password not logged)`);
    } else {
      console.log(`  🆕 [DCL] New account created — temporary credential saved to /tmp/secret: ${usernameList.join(', ')} (password not logged)`);
    }
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
  async injectCustomDataMongoDB(client, usernames) {
    const expiryDays = parseInt(process.env.DCL_PASSWORD_EXPIRY_DAYS ?? '7', 10);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    const customData = {
      expiresAt,
      passwordLastModified: now,
      description: 'Auto-created user, requires password change before expiry.'
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
  async getStoredChecksumsMariaDB(connection) {
    // Ensure checksum table exists
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS ${this.checksumTable} (
        id VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await connection.execute(
      `SELECT id, checksum, applied_at FROM ${this.checksumTable}`
    );

    const checksums = new Map();
    for (const row of rows) {
      checksums.set(row.id, {
        checksum: row.checksum,
        appliedAt: row.applied_at
      });
    }
    return checksums;
  }

  /**
   * Pre-check whether accounts that will be created by this file already exist.
   *
   * Looks for `CREATE USER … CHANGE_ME_ON_FIRST_LOGIN` patterns, extracts
   * the usernames, and queries `mysql.user` directly.  This is called BEFORE
   * executing the migration SQL so that the result is not polluted by stale
   * `SHOW WARNINGS` state left over from earlier queries on the same connection
   * (mysql2 multi-statement mode does not reset the warning buffer when a
   * subsequent query produces zero warnings).
   *
   * @param {Object} connection     - mysql2 pool connection
   * @param {string} originalContent - Raw (un-resolved) SQL content
   * @returns {Promise<boolean>} true when at least one target account already exists
   */
  async preCheckAccountsExistMariaDB(connection, originalContent) {
    const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';
    const usernames = [];
    // Strip comments and collapse whitespace so that multi-line statements like:
    //   CREATE USER IF NOT EXISTS 'app_user'@'%'
    //     IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
    //     PASSWORD EXPIRE;
    // are treated as a single unit and the username can be extracted correctly.
    const collapsed = this.stripCommentsAndCollapse(originalContent);
    for (const stmt of collapsed.split(';')) {
      // Only check CREATE USER — ALTER USER (reset_pwd) always targets an existing account,
      // so alreadyExists would always be true and incorrectly suppress /tmp/secret writes.
      if (!/\bCREATE\s+USER\b/i.test(stmt)) continue;
      if (!stmt.includes(PLACEHOLDER)) continue;
      const m = stmt.match(/['"\`]([^'"\`@\s]+)['"\`]\s*@/);
      if (m) usernames.push(m[1]);
    }
    if (usernames.length === 0) return false;

    const placeholders = usernames.map(() => '?').join(', ');
    const [[{ cnt }]] = await connection.query(
      `SELECT COUNT(*) AS cnt FROM mysql.user WHERE User IN (${placeholders})`,
      usernames
    );
    return Number(cnt) > 0;
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
        appliedAt: doc.appliedAt
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
  async updateChecksumMariaDB(connection, id, checksum) {
    await connection.execute(
      `INSERT INTO ${this.checksumTable} (id, checksum) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE checksum = ?, applied_at = CURRENT_TIMESTAMP`,
      [id, checksum, checksum]
    );
  }

  /**
   * Update checksum in database (MongoDB)
   * @param {Object} db - MongoDB database
   * @param {string} id - Migration ID
   * @param {string} checksum - New checksum
   */
  async updateChecksumMongoDB(db, id, checksum) {
    const collection = db.collection(this.checksumTable);
    await collection.updateOne(
      { _id: id },
      { $set: { checksum, appliedAt: new Date() } },
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
      storedChecksums = await this.getStoredChecksumsMariaDB(context.connection);
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
          reason: stored ? 'checksum changed' : 'new file',
          currentChecksum: file.checksum,
          storedChecksum: stored?.checksum || null
        });
      } else {
        upToDate.push({
          fileName: file.fileName,
          checksum: file.checksum,
          appliedAt: stored.appliedAt
        });
      }
    }

    return {
      pending,
      upToDate,
      total: files.length
    };
  }

  /**
   * Run repeatable migrations (MariaDB)
   * @param {Object} context - { connection, migrationsDir, validator? }
   * @returns {Promise<{applied: Array, errors: Array, skipped: Array}>}
   */
  async runMariaDB(context) {
    const { connection, migrationsDir, validator } = context;
    const result = { applied: [], errors: [], skipped: [] };

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
          allowedCodes: file.annotations.allowedCodes
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
        let alreadyExists = false;
        if (generated) {
          alreadyExists = await this.preCheckAccountsExistMariaDB(connection, file.content);
        }

        // Process DELIMITER for stored procedures support
        const sqlChunks = this.processDelimiterSQL(resolvedContent);

        for (const chunk of sqlChunks) {
          if (chunk.sql.trim()) {
            await connection.query(chunk.sql);
          }
        }

        // Persist generated credentials; `alreadyExists` was determined above
        // via a direct mysql.user query so it is immune to stale SHOW WARNINGS.
        if (generated) {
          await this.saveGeneratedPasswords(file.content, passwords, alreadyExists);
        }

        // Update checksum
        await this.updateChecksumMariaDB(connection, file.fileName, file.checksum);

        result.applied.push({
          fileName: file.fileName,
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
    const result = { applied: [], errors: [], skipped: [] };

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
          allowedCodes: file.annotations.allowedCodes
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
      }

      try {
        // Resolve CHANGE_ME_ON_FIRST_LOGIN → auto-generated password (in-memory only).
        // For JS files a temp file is written so the module can be dynamically imported.
        const { resolved: resolvedContent, generated, passwords } = this.resolvePlaceholderPasswords(file.content, file.fileName);

        let moduleToRun;
        let tempFilePath = null;
        if (generated) {
          // Write resolved JS to a temp file using .mjs extension so Node.js
          // treats it as ESM regardless of the /tmp directory having no package.json.
          const baseName = file.fileName.replace(/\.js$/, '.mjs');
          tempFilePath = path.join(os.tmpdir(), `dcl-${crypto.randomBytes(8).toString('hex')}-${baseName}`);
          await fs.writeFile(tempFilePath, resolvedContent, 'utf-8');
          moduleToRun = await import(`file://${tempFilePath}`);
        } else {
          moduleToRun = await import(`file://${file.filePath}?t=${Date.now()}`);
        }

        if (typeof moduleToRun.up !== 'function') {
          throw new Error('Migration must export an "up" function');
        }

        const upResult = await moduleToRun.up(db, client, mongodbHelpers);

        // Best-effort cleanup of temp file
        if (tempFilePath) await fs.unlink(tempFilePath).catch(() => {});

        // passwordSet: true  → new account
        // passwordSet: false → already existed
        // undefined          → template does not support return value (treat as unknown)
        const alreadyExists = upResult?.passwordSet === false;
        const isNewAccount  = upResult?.passwordSet === true;
        // Migration may explicitly report which usernames were created / managed
        const createdUsernames = upResult?.createdUsernames ?? null;
        const allUsernames     = upResult?.allUsernames ?? createdUsernames;

        // Persist credentials only for new accounts; pass allUsernames for warning log
        if (generated) {
          const namesForLog = isNewAccount ? createdUsernames : allUsernames;
          await this.saveGeneratedPasswords(file.content, passwords, alreadyExists, namesForLog);
        }

        // Inject customData (expiresAt, passwordLastModified) for new accounts
        if (isNewAccount) {
          // Prefer explicitly returned createdUsernames; fall back to regex parse
          let injectTargets = createdUsernames;
          if (!injectTargets) {
            injectTargets = [];
            for (const line of file.content.split('\n')) {
              const m = line.match(/const\s+username\s*=\s*['"]([^'"]+)['"]/);
              if (m) injectTargets.push(m[1]);
            }
          }
          if (injectTargets.length > 0) {
            await this.injectCustomDataMongoDB(client, injectTargets);
          }
        }

        // Update checksum
        await this.updateChecksumMongoDB(db, file.fileName, file.checksum);

        result.applied.push({
          fileName: file.fileName,
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
