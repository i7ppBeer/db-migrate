/**
 * DCL Idempotent Checker
 * Verifies that DCL scripts are idempotent (produce same result when run multiple times)
 * 
 * Test process:
 * 1. Execute script first time
 * 2. Capture database state
 * 3. Execute script second time  
 * 4. Capture database state again
 * 5. Compare states - must be identical
 */

export class DCLIdempotentChecker {
  constructor(options = {}) {
    this.verbose = options.verbose ?? true;
    this.stateFields = options.stateFields || ['users', 'roles', 'grants'];
  }

  /**
   * Log verbose message
   * @param {string} message
   */
  log(message) {
    if (this.verbose) {
      console.log(`   🔍 ${message}`);
    }
  }

  /**
   * Capture MariaDB DCL state (users, grants)
   * @param {Object} connection - MySQL connection
   * @param {string} database - Database name (optional, for db-specific grants)
   * @returns {Promise<Object>}
   */
  async captureMariaDBState(connection, database = null) {
    const state = {
      users: [],
      grants: [],
      timestamp: new Date().toISOString()
    };

    try {
      // Get users (excluding system users)
      const [users] = await connection.execute(`
        SELECT User, Host 
        FROM mysql.user 
        WHERE User NOT IN ('root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'healthchecker')
        ORDER BY User, Host
      `);
      state.users = users.map(u => `${u.User}@${u.Host}`);

      // Get grants for each user
      for (const user of users) {
        try {
          const [grants] = await connection.execute(
            `SHOW GRANTS FOR ?@?`,
            [user.User, user.Host]
          );
          for (const grant of grants) {
            const grantStr = Object.values(grant)[0];
            // Filter to relevant database if specified
            if (!database || grantStr.includes(`\`${database}\``) || grantStr.includes('*.*') || grantStr.includes('USAGE')) {
              state.grants.push({
                user: `${user.User}@${user.Host}`,
                grant: grantStr
              });
            }
          }
        } catch (e) {
          // User might have been dropped or no grants
        }
      }

      // Sort grants for consistent comparison
      state.grants.sort((a, b) => {
        if (a.user !== b.user) return a.user.localeCompare(b.user);
        return a.grant.localeCompare(b.grant);
      });

    } catch (error) {
      state.error = error.message;
    }

    return state;
  }

  /**
   * Capture MongoDB DCL state (users, roles)
   * @param {Object} db - MongoDB database
   * @returns {Promise<Object>}
   */
  async captureMongoDBState(db) {
    const state = {
      users: [],
      roles: [],
      timestamp: new Date().toISOString()
    };

    try {
      // Get users
      const usersInfo = await db.command({ usersInfo: 1 });
      state.users = (usersInfo.users || [])
        .filter(u => !u.user.startsWith('__system'))
        .map(u => ({
          user: u.user,
          db: u.db,
          roles: u.roles.map(r => `${r.role}@${r.db}`).sort()
        }))
        .sort((a, b) => a.user.localeCompare(b.user));

      // Get custom roles
      try {
        const rolesInfo = await db.command({ rolesInfo: 1, showBuiltinRoles: false });
        state.roles = (rolesInfo.roles || [])
          .map(r => ({
            role: r.role,
            db: r.db,
            privileges: r.privileges?.length || 0,
            inheritedRoles: r.roles?.map(ir => `${ir.role}@${ir.db}`).sort() || []
          }))
          .sort((a, b) => a.role.localeCompare(b.role));
      } catch (e) {
        // Roles might not be queryable
      }

    } catch (error) {
      state.error = error.message;
    }

    return state;
  }

  /**
   * Compare two states for equality
   * @param {Object} state1 - First state
   * @param {Object} state2 - Second state
   * @returns {{equal: boolean, differences: Array}}
   */
  compareStates(state1, state2) {
    const differences = [];

    // Remove timestamps for comparison
    const s1 = { ...state1 };
    const s2 = { ...state2 };
    delete s1.timestamp;
    delete s2.timestamp;

    // Deep compare
    const s1Json = JSON.stringify(s1, null, 2);
    const s2Json = JSON.stringify(s2, null, 2);

    if (s1Json !== s2Json) {
      // Find specific differences
      for (const field of this.stateFields) {
        const v1 = JSON.stringify(s1[field] || []);
        const v2 = JSON.stringify(s2[field] || []);
        if (v1 !== v2) {
          differences.push({
            field,
            before: s1[field],
            after: s2[field]
          });
        }
      }
    }

    return {
      equal: differences.length === 0,
      differences
    };
  }

  /**
   * Verify idempotency of a DCL script (MariaDB)
   * @param {Object} connection - MySQL connection
   * @param {Function} executeScript - Function to execute the script
   * @param {Object} options - { database, scriptName }
   * @returns {Promise<{success: boolean, error?: string, details?: Object}>}
   */
  async verifyMariaDB(connection, executeScript, options = {}) {
    const { database, scriptName } = options;
    
    this.log(`Testing idempotency for: ${scriptName || 'DCL script'}`);

    try {
      // Execute first time
      this.log('Execution 1...');
      await executeScript();
      
      // Capture state after first execution
      this.log('Capturing state after execution 1...');
      const state1 = await this.captureMariaDBState(connection, database);

      // Execute second time
      this.log('Execution 2...');
      await executeScript();

      // Capture state after second execution
      this.log('Capturing state after execution 2...');
      const state2 = await this.captureMariaDBState(connection, database);

      // Compare states
      const comparison = this.compareStates(state1, state2);

      if (comparison.equal) {
        this.log('✅ Idempotency verified - states are identical');
        return {
          success: true,
          details: {
            usersCount: state1.users.length,
            grantsCount: state1.grants.length
          }
        };
      } else {
        this.log('❌ Idempotency check FAILED - states differ');
        return {
          success: false,
          error: 'States differ after second execution',
          details: {
            differences: comparison.differences,
            state1,
            state2
          }
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verify idempotency of a DCL script (MongoDB)
   * @param {Object} db - MongoDB database
   * @param {Function} executeScript - Function to execute the script
   * @param {Object} options - { scriptName }
   * @returns {Promise<{success: boolean, error?: string, details?: Object}>}
   */
  async verifyMongoDB(db, executeScript, options = {}) {
    const { scriptName } = options;
    
    this.log(`Testing idempotency for: ${scriptName || 'DCL script'}`);

    try {
      // Execute first time
      this.log('Execution 1...');
      await executeScript();
      
      // Capture state after first execution
      this.log('Capturing state after execution 1...');
      const state1 = await this.captureMongoDBState(db);

      // Execute second time
      this.log('Execution 2...');
      await executeScript();

      // Capture state after second execution
      this.log('Capturing state after execution 2...');
      const state2 = await this.captureMongoDBState(db);

      // Compare states
      const comparison = this.compareStates(state1, state2);

      if (comparison.equal) {
        this.log('✅ Idempotency verified - states are identical');
        return {
          success: true,
          details: {
            usersCount: state1.users.length,
            rolesCount: state1.roles.length
          }
        };
      } else {
        this.log('❌ Idempotency check FAILED - states differ');
        return {
          success: false,
          error: 'States differ after second execution',
          details: {
            differences: comparison.differences,
            state1,
            state2
          }
        };
      }

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Verify idempotency (auto-detect type)
   * @param {Object} context - { connection?, db?, dbType }
   * @param {Function} executeScript - Function to execute the script
   * @param {Object} options - { database?, scriptName? }
   * @returns {Promise<{success: boolean, error?: string, details?: Object}>}
   */
  async verify(context, executeScript, options = {}) {
    const { dbType } = context;

    if (dbType === 'mariadb') {
      return this.verifyMariaDB(context.connection, executeScript, options);
    } else if (dbType === 'mongodb') {
      return this.verifyMongoDB(context.db, executeScript, options);
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }
  }
}

export default DCLIdempotentChecker;
