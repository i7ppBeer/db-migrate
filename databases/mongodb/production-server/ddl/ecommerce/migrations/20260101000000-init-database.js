/**
 * 20260101000000-init-database.js
 * Initialize ecommerce database
 * 
 * This migration serves as an explicit record of database initialization.
 * MongoDB automatically creates databases on first write, but this migration
 * provides version history and ensures the database exists before other migrations.
 * 
 * Note: Unlike MariaDB's DROP DATABASE which is blocked by validation rules,
 * MongoDB's dropDatabase() is also forbidden by default and requires --allow-forbidden.
 */

import { MongoDBChecks } from '../../../../../src/core/sanity-checker.js';

/**
 * Post-Check: Verify database initialization succeeded
 */
export async function postCheck({ db }) {
  const details = [];

  const metaExists = await MongoDBChecks.collectionExists(db, '_db_metadata');
  if (!metaExists) {
    return { success: false, error: 'Collection "_db_metadata" was not created' };
  }
  details.push('✓ Collection "_db_metadata" exists');

  const metaIndex = await MongoDBChecks.indexExists(db, '_db_metadata', 'key_1');
  if (!metaIndex) {
    return { success: false, error: 'Unique index on "_db_metadata.key" was not created' };
  }
  details.push('✓ Unique index on "_db_metadata.key" exists');

  return { success: true, details };
}

export async function up(db, client) {
  // MongoDB automatically creates the database on first operation
  // We'll create a system metadata collection to mark database initialization
  await db.createCollection('_db_metadata', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['key', 'value', 'createdAt'],
        properties: {
          key: { bsonType: 'string' },
          value: { bsonType: 'object' },
          createdAt: { bsonType: 'date' }
        }
      }
    }
  });

  // Insert initialization record
  await db.collection('_db_metadata').insertOne({
    key: 'database_initialized',
    value: {
      version: '1.0.0',
      database: 'ecommerce',
      purpose: 'E-commerce application database',
      charset: 'utf8mb4',
      initialized_by: 'db-migrate'
    },
    createdAt: new Date()
  });

  // Create index
  await db.collection('_db_metadata').createIndex({ key: 1 }, { unique: true });
}

export async function down(db, client) {
  // ⚠️ WARNING: This operation is FORBIDDEN by default!
  // It will be blocked by validation rules unless you use --allow-forbidden
  // This is a safety measure to prevent accidental data loss.
  // 
  // To execute this rollback, you must:
  // 1. Get approval from team lead
  // 2. Ensure backup exists
  // 3. Run: node src/cli.js down -c config.js --allow-forbidden
  
  // Note: We only drop the metadata collection here, not the entire database
  // Full database drop would require dropDatabase() which is forbidden
  await db.collection('_db_metadata').drop();
}
