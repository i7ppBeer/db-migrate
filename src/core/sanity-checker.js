/**
 * Sanity Check Framework
 * 
 * Provides pre-check, post-check (sanity check), and auto-rollback capabilities
 * for database migrations.
 * 
 * Usage:
 *   - Pre-Check: Validates preconditions before migration runs
 *   - Post-Check (Sanity): Validates the migration result after execution
 *   - Auto-Rollback: Automatically rolls back if sanity check fails
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} success - Whether the check passed
 * @property {string} [error] - Error message if check failed
 * @property {Array} [details] - Additional details
 */

/**
 * @typedef {Object} SanityCheckConfig
 * @property {boolean} enabled - Enable/disable sanity checks
 * @property {boolean} autoRollback - Auto rollback on sanity check failure
 * @property {number} timeoutMs - Timeout for sanity checks (default: 30000)
 * @property {Object} checks - Custom check configurations
 */

export class SanityChecker {
  constructor(options = {}) {
    this.options = {
      enabled: true,
      autoRollback: true,
      timeout: 30000,      // Also support 'timeout' for test compatibility
      timeoutMs: 30000,
      verbose: false,
      ...options
    };
    // Sync timeout and timeoutMs
    if (options.timeout) {
      this.options.timeoutMs = options.timeout;
    }
    if (options.timeoutMs) {
      this.options.timeout = options.timeoutMs;
    }
    
    this.results = {
      preCheck: null,
      migration: null,
      postCheck: null,
      rollback: null
    };
  }

  /**
   * Run a migration with full sanity check workflow:
   * 1. Pre-Check → 2. Execute Migration → 3. Post-Check (Sanity) → 4. Auto-Rollback if needed
   * 
   * Supports two API styles:
   * 1. Object style: runWithSanityCheck({ up, down, preCheck, postCheck, context })
   * 2. Migration style: runWithSanityCheck(migration, context, options)
   * 
   * @param {Object} paramsOrMigration - Either params object or migration object
   * @param {Object} [contextArg] - Context for migration style
   * @param {Object} [optionsArg] - Options for migration style
   * @returns {Promise<Object>} - Execution result
   */
  async runWithSanityCheck(paramsOrMigration, contextArg, optionsArg) {
    // Detect API style
    let up, down, preCheck, postCheck, context;
    let localAutoRollback = this.options.autoRollback;
    let localTimeout = this.options.timeoutMs;
    
    if (typeof paramsOrMigration.up === 'function' && contextArg !== undefined) {
      // Migration style: runWithSanityCheck(migration, context, options)
      up = paramsOrMigration.up;
      down = paramsOrMigration.down;
      preCheck = paramsOrMigration.preCheck;
      postCheck = paramsOrMigration.postCheck;
      context = contextArg || {};
      if (optionsArg) {
        if (optionsArg.autoRollback !== undefined) localAutoRollback = optionsArg.autoRollback;
        if (optionsArg.timeout !== undefined) localTimeout = optionsArg.timeout;
      }
    } else {
      // Object style: runWithSanityCheck({ up, down, preCheck, postCheck, context })
      up = paramsOrMigration.up;
      down = paramsOrMigration.down;
      preCheck = paramsOrMigration.preCheck;
      postCheck = paramsOrMigration.postCheck;
      context = paramsOrMigration.context || {};
    }
    if (!this.options.enabled) {
      // If sanity check is disabled, just run the migration
      this.log('⚠️  Sanity check disabled, running migration directly...');
      try {
        await up(context.db, context.client);
        return { success: true, skipped: true, message: 'Sanity check disabled' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    const startTime = Date.now();
    let migrationExecuted = false;
    
    try {
      // ═══════════════════════════════════════════════════════════
      // Phase 1: Pre-Check
      // ═══════════════════════════════════════════════════════════
      if (preCheck) {
        this.log('\n' + '═'.repeat(60));
        this.log('[PHASE 1] Pre-Check');
        this.log('═'.repeat(60));
        
        const preCheckResult = await this.runWithTimeout(
          () => preCheck(context.db, context.client),
          localTimeout,
          'Pre-check timed out'
        ).catch(err => ({ success: false, error: err.message }));
        
        this.results.preCheck = preCheckResult;
        
        if (!preCheckResult.success) {
          this.log(`❌ Pre-Check Failed: ${preCheckResult.error}`);
          return {
            success: false,
            preCheckResult,
            postCheckResult: null,
            migrationExecuted: false,
            rolledBack: false,
            phase: 'pre-check',
            error: preCheckResult.error,
            results: this.results,
            duration: Date.now() - startTime
          };
        }
        
        this.log('✅ Pre-Check Passed');
        if (preCheckResult.details) {
          for (const detail of preCheckResult.details) {
            this.log(`   • ${detail}`);
          }
        }
      }

      // ═══════════════════════════════════════════════════════════
      // Phase 2: Execute Migration
      // ═══════════════════════════════════════════════════════════
      this.log('\n' + '═'.repeat(60));
      this.log('[PHASE 2] Execute Migration');
      this.log('═'.repeat(60));

      await up(context.db, context.client);
      migrationExecuted = true;
      this.results.migration = { success: true };
      
      this.log('✅ Migration Executed');

      // ═══════════════════════════════════════════════════════════
      // Phase 3: Post-Check (Sanity Check)
      // ═══════════════════════════════════════════════════════════
      let postCheckResult = null;
      if (postCheck) {
        this.log('\n' + '═'.repeat(60));
        this.log('[PHASE 3] Sanity Check (Post-Check)');
        this.log('═'.repeat(60));
        
        postCheckResult = await this.runWithTimeout(
          () => postCheck(context.db, context.client),
          localTimeout,
          'Sanity check timed out'
        ).catch(err => ({ success: false, error: err.message }));
        
        this.results.postCheck = postCheckResult;
        
        if (!postCheckResult.success) {
          this.log(`❌ Sanity Check Failed: ${postCheckResult.error}`);
          
          // ═══════════════════════════════════════════════════════
          // Phase 4: Auto-Rollback (if enabled)
          // ═══════════════════════════════════════════════════════
          if (localAutoRollback && down) {
            this.log('\n' + '!'.repeat(60));
            this.log('[AUTO-ROLLBACK] Initiating automatic rollback...');
            this.log('!'.repeat(60));
            
            try {
              await down(context.db, context.client);
              this.results.rollback = { success: true };
              this.log('✅ Rollback Completed');
              
              return {
                success: false,
                preCheckResult: this.results.preCheck,
                postCheckResult,
                migrationExecuted: true,
                rolledBack: true,
                phase: 'post-check',
                error: postCheckResult.error,
                results: this.results,
                duration: Date.now() - startTime
              };
            } catch (rollbackError) {
              this.results.rollback = { success: false, error: rollbackError.message };
              this.log(`❌ CRITICAL: Rollback Failed: ${rollbackError.message}`);
              this.log('⚠️  Manual intervention required!');
              
              return {
                success: false,
                preCheckResult: this.results.preCheck,
                postCheckResult,
                migrationExecuted: true,
                rolledBack: false,
                rollbackError: rollbackError,
                phase: 'rollback',
                error: `Sanity check failed and rollback also failed: ${rollbackError.message}`,
                critical: true,
                results: this.results,
                duration: Date.now() - startTime
              };
            }
          }
          
          return {
            success: false,
            preCheckResult: this.results.preCheck,
            postCheckResult,
            migrationExecuted: true,
            rolledBack: false,
            phase: 'post-check',
            error: postCheckResult.error,
            results: this.results,
            duration: Date.now() - startTime
          };
        }
        
        this.log('✅ Sanity Check Passed');
        if (postCheckResult.details) {
          for (const detail of postCheckResult.details) {
            this.log(`   • ${detail}`);
          }
        }
      }

      // ═══════════════════════════════════════════════════════════
      // Success
      // ═══════════════════════════════════════════════════════════
      const duration = Date.now() - startTime;
      this.log('\n' + '═'.repeat(60));
      this.log(`✅ Migration completed successfully in ${duration}ms`);
      this.log('═'.repeat(60));
      
      return {
        success: true,
        preCheckResult: this.results.preCheck,
        postCheckResult: postCheckResult,
        migrationExecuted: true,
        rolledBack: false,
        results: this.results,
        duration
      };

    } catch (error) {
      // Migration itself failed - throw for test compatibility
      this.results.migration = { success: false, error: error.message };
      this.log(`\n❌ Migration Failed: ${error.message}`);
      
      throw error;
    }
  }

  /**
   * Run a function with timeout
   */
  async runWithTimeout(fn, timeoutMs, timeoutMessage) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * Log message if verbose mode is enabled
   */
  log(message) {
    if (this.options.verbose) {
      console.log(message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Built-in Check Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * MongoDB Sanity Check Helpers
 */
export const MongoDBChecks = {
  /**
   * Check if a collection exists
   */
  async collectionExists(db, collectionName) {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    return collections.length > 0;
  },

  /**
   * Check if an index exists on a collection
   */
  async indexExists(db, collectionName, indexName) {
    try {
      const indexes = await db.collection(collectionName).indexes();
      return indexes.some(idx => idx.name === indexName);
    } catch {
      return false;
    }
  },

  /**
   * Count documents in a collection with optional filter
   */
  async documentCount(db, collectionName, filter = {}) {
    return await db.collection(collectionName).countDocuments(filter);
  },

  /**
   * Check if all documents have a specific field
   */
  async hasField(db, collectionName, fieldName) {
    const missingCount = await db.collection(collectionName).countDocuments({
      [fieldName]: { $exists: false }
    });
    return missingCount === 0;
  },

  /**
   * Check if all documents have a specific field (legacy name)
   */
  async allDocumentsHaveField(db, collectionName, fieldName) {
    const missingCount = await db.collection(collectionName).countDocuments({
      [fieldName]: { $exists: false }
    });
    return {
      success: missingCount === 0,
      missingCount
    };
  },

  /**
   * Create a pre-check for collection existence
   */
  createCollectionExistsCheck(collectionName, shouldExist = true) {
    return async (db, client) => {
      const exists = await this.collectionExists(db, collectionName);
      if (shouldExist && !exists) {
        return { success: false, error: `Collection '${collectionName}' does not exist` };
      }
      if (!shouldExist && exists) {
        return { success: false, error: `Collection '${collectionName}' already exists` };
      }
      return { success: true };
    };
  },

  /**
   * Create a post-check for field existence on all documents
   */
  createFieldExistsCheck(collectionName, fieldName) {
    return async (db, client) => {
      const result = await this.allDocumentsHaveField(db, collectionName, fieldName);
      if (!result.success) {
        return { 
          success: false, 
          error: `${result.missingCount} documents missing field '${fieldName}'` 
        };
      }
      return { 
        success: true,
        details: [`All documents in '${collectionName}' have field '${fieldName}'`]
      };
    };
  }
};

/**
 * SQL Sanity Check Helpers (MariaDB/MySQL/PostgreSQL)
 */
export const SQLChecks = {
  /**
   * Check if a table exists (MariaDB/MySQL)
   */
  async tableExists(connection, tableName, database) {
    const [rows] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, tableName]
    );
    return rows.length > 0;
  },

  /**
   * Check if a column exists
   */
  async columnExists(connection, tableName, columnName, database) {
    const [rows] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [database, tableName, columnName]
    );
    return rows.length > 0;
  },

  /**
   * Check if an index exists
   */
  async indexExists(connection, tableName, indexName, database) {
    const [rows] = await connection.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [database, tableName, indexName]
    );
    return rows.length > 0;
  },

  /**
   * Count rows in a table with optional WHERE clause
   */
  async rowCount(connection, tableName, whereClause = null, params = []) {
    let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }
    const [rows] = await connection.execute(sql, params);
    return rows[0].count;
  },

  /**
   * Get column info
   */
  async getColumnInfo(connection, tableName, columnName, database) {
    const [rows] = await connection.query(
      `SELECT DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [database, tableName, columnName]
    );
    return rows[0] || null;
  },

  /**
   * Create a pre-check for table existence
   */
  createTableExistsCheck(tableName, database, shouldExist = true) {
    return async (context) => {
      const exists = await this.tableExists(context.connection, tableName, database);
      if (shouldExist && !exists) {
        return { success: false, error: `Table '${tableName}' does not exist` };
      }
      if (!shouldExist && exists) {
        return { success: false, error: `Table '${tableName}' already exists` };
      }
      return { success: true };
    };
  },

  /**
   * Create a post-check for column existence and type
   */
  createColumnCheck(tableName, columnName, database, expectedType = null, expectedNullable = null) {
    return async (context) => {
      const columnInfo = await this.getColumnInfo(
        context.connection, tableName, columnName, database
      );
      
      if (!columnInfo) {
        return { success: false, error: `Column '${columnName}' does not exist in table '${tableName}'` };
      }
      
      const details = [];
      details.push(`Column '${columnName}' exists in '${tableName}'`);
      
      if (expectedType && columnInfo.DATA_TYPE.toLowerCase() !== expectedType.toLowerCase()) {
        return { 
          success: false, 
          error: `Column '${columnName}' has wrong type: expected '${expectedType}', got '${columnInfo.DATA_TYPE}'` 
        };
      }
      details.push(`Type: ${columnInfo.DATA_TYPE}`);
      
      if (expectedNullable !== null) {
        const isNullable = columnInfo.IS_NULLABLE === 'YES';
        if (isNullable !== expectedNullable) {
          return { 
            success: false, 
            error: `Column '${columnName}' nullable mismatch: expected ${expectedNullable ? 'NULL' : 'NOT NULL'}` 
          };
        }
        details.push(`Nullable: ${columnInfo.IS_NULLABLE}`);
      }
      
      return { success: true, details };
    };
  }
};

export default SanityChecker;
