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

export class RepeatableRunner {
  constructor(config) {
    this.config = config;
    this.checksumTable = config.checksumTable || 'repeatable_migrations';
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
        // Process DELIMITER for stored procedures support
        const sqlChunks = this.processDelimiterSQL(file.content);
        
        for (const chunk of sqlChunks) {
          if (chunk.sql.trim()) {
            // Execute each chunk
            await connection.query(chunk.sql);
          }
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
        // Import and execute the JS module
        const module = await import(`file://${file.filePath}?t=${Date.now()}`);
        
        if (typeof module.up !== 'function') {
          throw new Error('Migration must export an "up" function');
        }

        await module.up(db, client);
        
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
