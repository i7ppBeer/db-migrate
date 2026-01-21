/**
 * Repeatable Migration Runner
 * Handles DCL (Data Control Language) migrations using checksum-based execution
 * 
 * Repeatable migrations:
 * - File naming: R__*.sql or R__*.js
 * - No down migration required
 * - Re-executes when checksum changes
 * - Must be idempotent
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
   * @returns {Promise<Array<{fileName: string, filePath: string, content: string, checksum: string}>>}
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
      result.push({ fileName, filePath, content, checksum });
    }

    return result;
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
   * @param {Object} context - { connection, migrationsDir }
   * @returns {Promise<{applied: Array, errors: Array}>}
   */
  async runMariaDB(context) {
    const { connection, migrationsDir } = context;
    const result = { applied: [], errors: [] };

    const files = await this.getRepeatableFiles(migrationsDir);
    const storedChecksums = await this.getStoredChecksumsMariaDB(connection);

    for (const file of files) {
      const stored = storedChecksums.get(file.fileName);
      
      // Skip if checksum matches
      if (stored && stored.checksum === file.checksum) {
        continue;
      }

      try {
        // Execute the SQL
        await connection.execute(file.content);
        
        // Update checksum
        await this.updateChecksumMariaDB(connection, file.fileName, file.checksum);
        
        result.applied.push({
          fileName: file.fileName,
          reason: stored ? 'checksum changed' : 'new file'
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
   * @param {Object} context - { db, client, migrationsDir }
   * @returns {Promise<{applied: Array, errors: Array}>}
   */
  async runMongoDB(context) {
    const { db, client, migrationsDir } = context;
    const result = { applied: [], errors: [] };

    const files = await this.getRepeatableFiles(migrationsDir);
    const storedChecksums = await this.getStoredChecksumsMongoDB(db);

    for (const file of files) {
      const stored = storedChecksums.get(file.fileName);
      
      // Skip if checksum matches
      if (stored && stored.checksum === file.checksum) {
        continue;
      }

      try {
        // Import and execute the JS module
        const module = await import(`file://${file.filePath}`);
        
        if (typeof module.up !== 'function') {
          throw new Error('Migration must export an "up" function');
        }

        await module.up(db, client);
        
        // Update checksum
        await this.updateChecksumMongoDB(db, file.fileName, file.checksum);
        
        result.applied.push({
          fileName: file.fileName,
          reason: stored ? 'checksum changed' : 'new file'
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
