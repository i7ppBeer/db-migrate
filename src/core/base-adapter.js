/**
 * Base Adapter Interface
 * All database adapters must implement this interface
 */

export class BaseAdapter {
  constructor(config) {
    this.config = config;
    this.dbType = 'unknown';
  }

  /**
   * Get database type identifier
   * @returns {string}
   */
  getType() {
    return this.dbType;
  }

  /**
   * Connect to database
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from database
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Get migration status
   * @returns {Promise<{pending: Array, applied: Array}>}
   */
  async status() {
    throw new Error('status() must be implemented by subclass');
  }

  /**
   * Run pending migrations (up)
   * @returns {Promise<{applied: Array, errors: Array}>}
   */
  async up() {
    throw new Error('up() must be implemented by subclass');
  }

  /**
   * Rollback last migration (down)
   * @param {number} count - Number of migrations to rollback
   * @returns {Promise<{rolledBack: Array, errors: Array}>}
   */
  async down(count = 1) {
    throw new Error('down() must be implemented by subclass');
  }

  /**
   * Create a new migration file
   * @param {string} name - Migration name
   * @returns {Promise<string>} - Created file path
   */
  async create(name) {
    throw new Error('create() must be implemented by subclass');
  }

  /**
   * Validate migration files
   * @returns {Promise<{valid: boolean, results: Array}>}
   */
  async validate() {
    throw new Error('validate() must be implemented by subclass');
  }

  /**
   * Get validation rules for this database type
   * @returns {Object}
   */
  getValidationRules() {
    throw new Error('getValidationRules() must be implemented by subclass');
  }

  /**
   * Run Up-Down-Up test
   * @returns {Promise<{success: boolean, stages: Object}>}
   */
  async runUpDownUpTest() {
    const results = {
      success: false,
      stages: {
        up1: { success: false, count: 0, error: null },
        down: { success: false, count: 0, error: null },
        up2: { success: false, count: 0, error: null }
      },
      duration: 0
    };

    const startTime = Date.now();

    try {
      // Stage 1: UP
      console.log('\n📤 Stage 1: Running UP migrations...');
      const up1Result = await this.up();
      results.stages.up1 = {
        success: up1Result.errors.length === 0,
        count: up1Result.applied.length,
        applied: up1Result.applied,
        error: up1Result.errors[0] || null
      };

      if (!results.stages.up1.success) {
        throw new Error(`Stage 1 (UP) failed: ${results.stages.up1.error}`);
      }
      console.log(`   ✅ Applied ${results.stages.up1.count} migrations`);

      // Get the total number of applied migrations after Stage 1
      // (may be more than up1.count if some were already applied from a previous run)
      const statusAfterUp1 = await this.status();
      const totalApplied = statusAfterUp1.applied.length;

      // Stage 2: DOWN (rollback all currently applied migrations)
      console.log('\n📥 Stage 2: Running DOWN migrations (rollback)...');
      const downResult = await this.down(totalApplied);
      results.stages.down = {
        success: downResult.errors.length === 0,
        count: downResult.rolledBack.length,
        rolledBack: downResult.rolledBack,
        error: downResult.errors[0] || null
      };

      if (!results.stages.down.success) {
        throw new Error(`Stage 2 (DOWN) failed: ${results.stages.down.error}`);
      }
      console.log(`   ✅ Rolled back ${results.stages.down.count} migrations`);

      // Stage 3: UP again
      console.log('\n📤 Stage 3: Running UP migrations again...');
      const up2Result = await this.up();
      results.stages.up2 = {
        success: up2Result.errors.length === 0,
        count: up2Result.applied.length,
        applied: up2Result.applied,
        error: up2Result.errors[0] || null
      };

      if (!results.stages.up2.success) {
        throw new Error(`Stage 3 (UP Again) failed: ${results.stages.up2.error}`);
      }
      console.log(`   ✅ Re-applied ${results.stages.up2.count} migrations`);

      // Verify Stage 3 re-applied as many as Stage 2 rolled back
      if (results.stages.down.count !== results.stages.up2.count) {
        throw new Error(
          `Migration count mismatch: Stage 2 rolled back ${results.stages.down.count}, ` +
          `Stage 3 re-applied ${results.stages.up2.count}`
        );
      }

      results.success = true;

    } catch (error) {
      results.error = error.message;
      // Attempt cleanup on failure to restore to a known state
      try {
        console.warn('\n⚠️  Test failed, attempting cleanup...');
        const cleanupStatus = await this.status();
        await this.down(cleanupStatus.applied.length || 0);
        console.warn('   Cleanup completed.');
      } catch (cleanupError) {
        console.error(`   ❌ Cleanup also failed: ${cleanupError.message}`);
      }
    }

    results.duration = Date.now() - startTime;
    return results;
  }
}

export default BaseAdapter;
