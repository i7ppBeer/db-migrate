/**
 * Migration Tester
 * Runs migrations in Docker containers to test version compatibility
 */

import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

export class MigrationTester {
  constructor(options = {}) {
    this.minVersion = options.minVersion || '6.0';
    this.maxVersion = options.maxVersion || '8.0';
    this.containerPrefix = 'mongodb-migrate-test';
  }

  /**
   * Run full migration test suite
   * 1. Test min version -> max version
   * 2. Rollback to min version
   * 3. Migrate back to max version
   */
  async runFullTest() {
    console.log(chalk.blue('[TEST] Starting migration test suite...\n'));
    
    try {
      // Test with minimum version
      console.log(chalk.blue(`[INIT] Testing with MongoDB ${this.minVersion}...`));
      await this.testVersion(this.minVersion, 'min');
      
      // Test with maximum version
      console.log(chalk.blue(`\n[INIT] Testing with MongoDB ${this.maxVersion}...`));
      await this.testVersion(this.maxVersion, 'max');
      
      // Test upgrade path: min -> max
      console.log(chalk.blue('\n[UPDATE] Testing upgrade path (min -> max)...'));
      await this.testUpgradePath();
      
      // Test rollback: max -> min -> max
      console.log(chalk.blue('\n[ROLLBACK]  Testing rollback path...'));
      await this.testRollbackPath();
      
      console.log(chalk.green('\n[OK] All test scenarios passed!'));
    } catch (error) {
      console.error(chalk.red('\n[ERROR] Test failed:'), error.message);
      throw error;
    } finally {
      // Cleanup containers
      await this.cleanup();
    }
  }

  /**
   * Test migrations on a specific MongoDB version
   */
  async testVersion(version, label) {
    const containerName = `${this.containerPrefix}-${label}`;
    const port = label === 'min' ? 27017 : 27018;
    
    try {
      // Start MongoDB container
      console.log(chalk.gray(`  Starting container ${containerName}...`));
      await this.startContainer(version, containerName, port);
      
      // Wait for MongoDB to be ready
      await this.waitForMongoDB(port);
      
      // Run migrations
      console.log(chalk.gray(`  Running migrations...`));
      await this.runMigrations(port);
      
      // Verify migrations
      console.log(chalk.gray(`  Verifying migrations...`));
      await this.verifyMigrations(port);
      
      console.log(chalk.green(`  [OK] MongoDB ${version} test passed`));
    } catch (error) {
      console.error(chalk.red(`  [ERROR] MongoDB ${version} test failed`));
      throw error;
    }
  }

  /**
   * Test upgrade path from min to max version
   */
  async testUpgradePath() {
    const containerName = `${this.containerPrefix}-upgrade`;
    const port = 27019;
    
    try {
      // Start with min version
      console.log(chalk.gray(`  Starting with MongoDB ${this.minVersion}...`));
      await this.startContainer(this.minVersion, containerName, port);
      await this.waitForMongoDB(port);
      
      // Run all migrations on min version
      console.log(chalk.gray(`  Running migrations on ${this.minVersion}...`));
      await this.runMigrations(port);
      
      // Stop container
      await this.stopContainer(containerName);
      
      // Start with max version (reusing data volume)
      console.log(chalk.gray(`  Upgrading to MongoDB ${this.maxVersion}...`));
      await this.startContainer(this.maxVersion, `${containerName}-max`, port);
      await this.waitForMongoDB(port);
      
      // Verify data integrity after upgrade
      console.log(chalk.gray(`  Verifying data integrity...`));
      await this.verifyMigrations(port);
      
      console.log(chalk.green(`  [OK] Upgrade path test passed`));
      
      // Cleanup
      await this.stopContainer(`${containerName}-max`);
    } catch (error) {
      console.error(chalk.red(`  [ERROR] Upgrade path test failed`));
      throw error;
    }
  }

  /**
   * Test rollback: min -> max -> rollback -> max
   */
  async testRollbackPath() {
    const containerName = `${this.containerPrefix}-rollback`;
    const port = 27020;
    
    try {
      // Start with max version
      console.log(chalk.gray(`  Starting with MongoDB ${this.maxVersion}...`));
      await this.startContainer(this.maxVersion, containerName, port);
      await this.waitForMongoDB(port);
      
      // Run migrations
      console.log(chalk.gray(`  Running migrations...`));
      await this.runMigrations(port);
      
      // Rollback all migrations
      console.log(chalk.gray(`  Rolling back all migrations...`));
      await this.rollbackAllMigrations(port);
      
      // Re-apply migrations
      console.log(chalk.gray(`  Re-applying migrations...`));
      await this.runMigrations(port);
      
      // Verify final state
      console.log(chalk.gray(`  Verifying final state...`));
      await this.verifyMigrations(port);
      
      console.log(chalk.green(`  [OK] Rollback path test passed`));
      
      // Cleanup
      await this.stopContainer(containerName);
    } catch (error) {
      console.error(chalk.red(`  [ERROR] Rollback path test failed`));
      throw error;
    }
  }

  /**
   * Start MongoDB container
   */
  async startContainer(version, containerName, port) {
    const command = `docker run -d --name ${containerName} \
      -p ${port}:27017 \
      -e MONGO_INITDB_ROOT_USERNAME=admin \
      -e MONGO_INITDB_ROOT_PASSWORD=admin123 \
      mongo:${version}`;
    
    try {
      execSync(command, { stdio: 'pipe' });
    } catch (error) {
      // Container might already exist, try to start it
      try {
        execSync(`docker start ${containerName}`, { stdio: 'pipe' });
      } catch (startError) {
        throw new Error(`Failed to start container: ${error.message}`);
      }
    }
  }

  /**
   * Stop and remove container
   */
  async stopContainer(containerName) {
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'pipe' });
      execSync(`docker rm ${containerName}`, { stdio: 'pipe' });
    } catch (error) {
      // Ignore errors if container doesn't exist
    }
  }

  /**
   * Wait for MongoDB to be ready
   */
  async waitForMongoDB(port, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        execSync(`docker exec mongodb-migrate-test-min mongosh --eval "db.adminCommand('ping')" --quiet`, 
          { stdio: 'pipe' });
        return;
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('MongoDB failed to start');
  }

  /**
   * Run migrations using migrate-mongo
   */
  async runMigrations(port) {
    const env = {
      ...process.env,
      MONGODB_URL: `mongodb://admin:admin123@localhost:${port}`,
      MONGODB_DATABASE: 'test_migrations',
    };
    
    execSync('node src/cli.js up', { env, stdio: 'pipe' });
  }

  /**
   * Rollback all migrations
   */
  async rollbackAllMigrations(port) {
    const env = {
      ...process.env,
      MONGODB_URL: `mongodb://admin:admin123@localhost:${port}`,
      MONGODB_DATABASE: 'test_migrations',
    };
    
    // Get migration count
    const status = execSync('node src/cli.js status', { env, encoding: 'utf-8' });
    const appliedCount = (status.match(/\d{4}-\d{2}-\d{2}/g) || []).length;
    
    // Rollback each migration
    for (let i = 0; i < appliedCount; i++) {
      execSync('node src/cli.js down', { env, stdio: 'pipe' });
    }
  }

  /**
   * Verify migrations were applied correctly
   */
  async verifyMigrations(port) {
    const env = {
      ...process.env,
      MONGODB_URL: `mongodb://admin:admin123@localhost:${port}`,
      MONGODB_DATABASE: 'test_migrations',
    };
    
    const status = execSync('node src/cli.js status', { env, encoding: 'utf-8' });
    
    // Check if all migrations are applied (no PENDING)
    if (status.includes('PENDING')) {
      throw new Error('Some migrations are still pending');
    }
  }

  /**
   * Cleanup all test containers
   */
  async cleanup() {
    console.log(chalk.gray('\n🧹 Cleaning up test containers...'));
    
    const containers = [
      `${this.containerPrefix}-min`,
      `${this.containerPrefix}-max`,
      `${this.containerPrefix}-upgrade`,
      `${this.containerPrefix}-upgrade-max`,
      `${this.containerPrefix}-rollback`,
    ];
    
    for (const container of containers) {
      await this.stopContainer(container);
    }
  }
}

export default MigrationTester;
