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
      timeoutMs: 30000,
      verbose: false,
      ...options
    };
    
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
   * @param {Object} params
   * @param {Function} params.up - Migration up function
   * @param {Function} params.down - Migration down function  
   * @param {Function} [params.preCheck] - Pre-check function (returns { success, error })
   * @param {Function} [params.postCheck] - Post-check/sanity function (returns { success, error })
   * @param {Object} [params.context] - Context passed to all functions (db, client, etc.)
   * @returns {Promise<Object>} - Execution result
   */
  async runWithSanityCheck({ up, down, preCheck, postCheck, context = {} }) {
    if (!this.options.enabled) {
      // If sanity check is disabled, just run the migration
      this.log('⚠️  Sanity check disabled, running migration directly...');
      try {
        await up(context);
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
          () => preCheck(context),
          this.options.timeoutMs,
          'Pre-check timed out'
        );
        
        this.results.preCheck = preCheckResult;
        
        if (!preCheckResult.success) {
          this.log(`❌ Pre-Check Failed: ${preCheckResult.error}`);
          return {
            success: false,
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
      
      await up(context);
      migrationExecuted = true;
      this.results.migration = { success: true };
      
      this.log('✅ Migration Executed');

      // ═══════════════════════════════════════════════════════════
      // Phase 3: Post-Check (Sanity Check)
      // ═══════════════════════════════════════════════════════════
      if (postCheck) {
        this.log('\n' + '═'.repeat(60));
        this.log('[PHASE 3] Sanity Check (Post-Check)');
        this.log('═'.repeat(60));
        
        const postCheckResult = await this.runWithTimeout(
          () => postCheck(context),
          this.options.timeoutMs,
          'Sanity check timed out'
        );
        
        this.results.postCheck = postCheckResult;
        
        if (!postCheckResult.success) {
          this.log(`❌ Sanity Check Failed: ${postCheckResult.error}`);
          
          // ═══════════════════════════════════════════════════════
          // Phase 4: Auto-Rollback (if enabled)
          // ═══════════════════════════════════════════════════════
          if (this.options.autoRollback && down) {
            this.log('\n' + '!'.repeat(60));
            this.log('[AUTO-ROLLBACK] Initiating automatic rollback...');
            this.log('!'.repeat(60));
            
            try {
              await down(context);
              this.results.rollback = { success: true };
              this.log('✅ Rollback Completed');
              
              return {
                success: false,
                phase: 'post-check',
                error: postCheckResult.error,
                rolledBack: true,
                results: this.results,
                duration: Date.now() - startTime
              };
            } catch (rollbackError) {
              this.results.rollback = { success: false, error: rollbackError.message };
              this.log(`❌ CRITICAL: Rollback Failed: ${rollbackError.message}`);
              this.log('⚠️  Manual intervention required!');
              
              return {
                success: false,
                phase: 'rollback',
                error: `Sanity check failed and rollback also failed: ${rollbackError.message}`,
                rolledBack: false,
                critical: true,
                results: this.results,
                duration: Date.now() - startTime
              };
            }
          }
          
          return {
            success: false,
            phase: 'post-check',
            error: postCheckResult.error,
            rolledBack: false,
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
        results: this.results,
        duration
      };

    } catch (error) {
      // Migration itself failed
      this.results.migration = { success: false, error: error.message };
      this.log(`\n❌ Migration Failed: ${error.message}`);
      
      // Auto-rollback if migration was partially executed
      if (migrationExecuted && this.options.autoRollback && down) {
        this.log('\n[AUTO-ROLLBACK] Migration failed, attempting rollback...');
        try {
          await down(context);
          this.results.rollback = { success: true };
          this.log('✅ Rollback Completed');
        } catch (rollbackError) {
          this.results.rollback = { success: false, error: rollbackError.message };
          this.log(`❌ Rollback Failed: ${rollbackError.message}`);
        }
      }
      
      return {
        success: false,
        phase: 'migration',
        error: error.message,
        rolledBack: this.results.rollback?.success || false,
        results: this.results,
        duration: Date.now() - startTime
      };
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
   * Check if all documents have a specific field
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
    return async (context) => {
      const exists = await this.collectionExists(context.db, collectionName);
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
    return async (context) => {
      const result = await this.allDocumentsHaveField(context.db, collectionName, fieldName);
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
