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

      // Stage 2: DOWN (rollback all)
      console.log('\n📥 Stage 2: Running DOWN migrations (rollback)...');
      const downResult = await this.down(results.stages.up1.count);
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

      // Verify counts match
      if (results.stages.up1.count !== results.stages.up2.count) {
        throw new Error(
          `Migration count mismatch: Stage 1 applied ${results.stages.up1.count}, ` +
          `Stage 3 applied ${results.stages.up2.count}`
        );
      }

      results.success = true;

    } catch (error) {
      results.error = error.message;
    }

    results.duration = Date.now() - startTime;
    return results;
  }
}

export default BaseAdapter;
