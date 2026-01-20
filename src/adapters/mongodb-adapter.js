/**
 * MongoDB Adapter
 * Wraps migrate-mongo for MongoDB migrations
 */

import { BaseAdapter } from '../core/base-adapter.js';
import migrateMongo from 'migrate-mongo';
import { MongoClient } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';

export class MongoDBAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.dbType = 'mongodb';
    this.client = null;
    this.db = null;
  }

  /**
   * Get MongoDB-specific validation rules
   */
  getValidationRules() {
    return {
      forbidden: {
        database: [
          'dropDatabase',
          'createUser',
          'dropUser', 
          'updateUser',
          'grantRolesToUser',
          'revokeRolesFromUser',
          'createRole',
          'dropRole',
          'updateRole',
          'repairDatabase',
          'cloneDatabase',
          'copyDatabase'
        ],
        collections: [
          'drop',
          'dropCollection',
          'reIndex'
        ],
        system: [
          'shutdown',
          'killOp',
          'killAllSessions',
          'serverStatus',
          'replSetGetStatus',
          'isMaster'
        ],
        admin: [
          'enableSharding',
          'shardCollection',
          'movePrimary',
          'removeShard'
        ]
      },
      warnings: {
        operations: [
          'deleteMany',
          'updateMany',
          'mapReduce',
          'renameCollection'
        ]
      }
    };
  }

  async connect() {
    try {
      // Set migrate-mongo config
      migrateMongo.config.set(this.config);
      
      // Connect using migrate-mongo's method
      const { db, client } = await migrateMongo.database.connect();
      this.db = db;
      this.client = client;
      
      return { db, client };
    } catch (error) {
      throw new Error(`MongoDB connection failed: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async status() {
    try {
      const statusResult = await migrateMongo.status(this.db);
      
      const pending = statusResult.filter(m => m.appliedAt === 'PENDING');
      const applied = statusResult.filter(m => m.appliedAt !== 'PENDING');
      
      return {
        pending: pending.map(m => m.fileName),
        applied: applied.map(m => ({
          fileName: m.fileName,
          appliedAt: m.appliedAt
        })),
        total: statusResult.length
      };
    } catch (error) {
      throw new Error(`Failed to get status: ${error.message}`);
    }
  }

  async up() {
    const result = {
      applied: [],
      errors: []
    };

    try {
      const migrated = await migrateMongo.up(this.db, this.client);
      result.applied = migrated;
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  async down(count = 1) {
    const result = {
      rolledBack: [],
      errors: []
    };

    try {
      for (let i = 0; i < count; i++) {
        const migrated = await migrateMongo.down(this.db, this.client);
        if (migrated.length === 0) break;
        result.rolledBack.push(...migrated);
      }
    } catch (error) {
      result.errors.push(error.message);
    }

    return result;
  }

  async create(name) {
    try {
      const fileName = await migrateMongo.create(name);
      return fileName;
    } catch (error) {
      throw new Error(`Failed to create migration: ${error.message}`);
    }
  }

  async validate() {
    const results = {
      valid: true,
      results: []
    };

    try {
      const migrationsDir = this.config.migrationsDir;
      const files = await fs.readdir(migrationsDir);
      const migrationFiles = files.filter(f => f.endsWith('.js'));

      for (const file of migrationFiles) {
        const filePath = path.join(migrationsDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const fileResult = this.validateContent(content, file);
        
        results.results.push({
          file,
          ...fileResult
        });

        if (!fileResult.valid) {
          results.valid = false;
        }
      }
    } catch (error) {
      results.valid = false;
      results.error = error.message;
    }

    return results;
  }

  validateContent(content, fileName) {
    const errors = [];
    const warnings = [];
    const rules = this.getValidationRules();

    // Extract up() and down() function bodies
    const upBody = this.extractFunctionBody(content, 'up');
    const downBody = this.extractFunctionBody(content, 'down');

    // === 1. Check for empty down() when up() has operations ===
    const upHasOperations = upBody.trim().length > 0 && 
      (this.containsOperation(upBody, 'createCollection') ||
       this.containsOperation(upBody, 'createIndex') ||
       this.containsOperation(upBody, 'insertMany') ||
       this.containsOperation(upBody, 'insertOne'));
    
    const downIsEmpty = !downBody.trim() || 
      downBody.trim() === '// BUG: Empty down() - no rollback!' ||
      !(/\w+\s*\.\s*\w+\s*\(/.test(downBody)); // No method calls
    
    if (upHasOperations && downIsEmpty) {
      errors.push({
        type: 'missing-down',
        operation: 'down()',
        message: 'down() is empty but up() contains operations - rollback missing!'
      });
    }

    // === 2. Extract created collections in up() ===
    const createdCollections = this.extractCreatedCollections(upBody);
    const droppedCollectionsInDown = this.extractDroppedCollections(downBody);
    const droppedCollectionsInUp = this.extractDroppedCollections(upBody);
    
    // === 3. Check for orphan drops in down() ===
    for (const dropped of droppedCollectionsInDown) {
      if (!createdCollections.includes(dropped)) {
        errors.push({
          type: 'orphan-drop',
          operation: 'drop',
          message: `Orphan drop: down() drops '${dropped}' but up() doesn't create it`
        });
      }
    }

    // === 3b. Check for orphan drops in up() ===
    for (const dropped of droppedCollectionsInUp) {
      if (!createdCollections.includes(dropped)) {
        errors.push({
          type: 'orphan-drop-in-up',
          operation: 'drop',
          message: `Orphan drop in up(): '${dropped}' is dropped but not created in this migration`
        });
      }
    }

    // === 4. Check for forbidden operations ===
    for (const category of Object.keys(rules.forbidden)) {
      for (const operation of rules.forbidden[category]) {
        // Special case: Allow 'drop' in down() for collections created in up()
        if ((operation === 'drop' || operation === 'dropCollection')) {
          const hasDropInDown = this.containsOperation(downBody, operation);
          const hasDropInUp = this.containsOperation(upBody, operation);
          
          // If drop is only in down() and all dropped collections are created in up(), it's OK
          if (hasDropInDown && !hasDropInUp) {
            const allDropsAreValid = droppedCollectionsInDown.every(c => createdCollections.includes(c));
            if (allDropsAreValid && droppedCollectionsInDown.length > 0) {
              warnings.push({
                type: 'allowed-drop-for-create',
                operation,
                message: `[ALLOWED] ${operation} in down() for collections created in up()`
              });
              continue;
            }
          }
          // If drop is in up(), it's forbidden (unless it's for cleanup within the migration)
          if (hasDropInUp && droppedCollectionsInUp.some(c => !createdCollections.includes(c))) {
            errors.push({
              type: `forbidden-${category}-operation`,
              operation,
              message: `Forbidden ${category} operation: ${operation} in up() for non-created collections`
            });
          }
          continue;
        }

        // Check DCL operations (createUser, dropUser, etc.)
        if (this.containsOperation(content, operation)) {
          errors.push({
            type: `forbidden-${category}-operation`,
            operation,
            message: `Forbidden ${category} operation: ${operation}`
          });
        }
      }
    }

    // === 5. Check for warning operations ===
    for (const operation of rules.warnings.operations) {
      if (this.containsOperation(content, operation)) {
        warnings.push({
          type: 'warning-operation',
          operation,
          message: `Warning: ${operation} can affect large amounts of data`
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  extractCreatedCollections(code) {
    const collections = [];
    // Match: createCollection('name') or createCollection("name")
    const regex = /createCollection\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      collections.push(match[1]);
    }
    return collections;
  }

  extractDroppedCollections(code) {
    const collections = [];
    // Match: collection('name').drop() or .collection("name").drop
    const regex = /collection\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*drop/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
      collections.push(match[1]);
    }
    return collections;
  }

  extractFunctionBody(content, functionName) {
    const patterns = [
      // export async function up(db, client) { ... }
      new RegExp(`export\\s+async\\s+function\\s+${functionName}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)}(?=\\s*export|\\s*$)`, 'm'),
      // export const up = async (db, client) => { ... }
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*{([\\s\\S]*?)}\\s*;?`, 'm'),
      // async up(db, client) { ... }
      new RegExp(`async\\s+${functionName}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)}`, 'm'),
    ];
    
    for (const regex of patterns) {
      const match = content.match(regex);
      if (match) return match[1];
    }
    return '';
  }

  containsOperation(code, operation) {
    const patterns = [
      new RegExp(`\\.${operation}\\s*\\(`),           // .createUser(
      new RegExp(`\\['${operation}'\\]`),             // ['createUser']
      new RegExp(`\\["${operation}"\\]`),             // ["createUser"]
      new RegExp(`db\\.${operation}`),                // db.createUser
      new RegExp(`${operation}\\s*:\\s*['"]`),        // createUser: 'name' (in db.command)
      new RegExp(`${operation}\\s*:\\s*[\\w$]`),      // createUser: variableName
    ];
    return patterns.some(p => p.test(code));
  }
}

export default MongoDBAdapter;
