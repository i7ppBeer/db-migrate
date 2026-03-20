/**
 * 20260101000001-create-users.js
 * Create users collection with indexes
 */

import { MongoDBChecks } from '../../../../../src/core/sanity-checker.js';

/**
 * Pre-Check: Verify users collection does not already exist
 */
export async function preCheck({ db }) {
  const details = [];

  const exists = await MongoDBChecks.collectionExists(db, 'users');
  if (exists) {
    return { success: false, error: 'Collection "users" already exists. Migration may have been applied.' };
  }
  details.push('✓ Collection "users" does not exist yet');

  return { success: true, details };
}

/**
 * Post-Check: Verify users collection and indexes were created
 */
export async function postCheck({ db }) {
  const details = [];

  const collectionExists = await MongoDBChecks.collectionExists(db, 'users');
  if (!collectionExists) {
    return { success: false, error: 'Collection "users" was not created' };
  }
  details.push('✓ Collection "users" exists');

  const emailIndexExists = await MongoDBChecks.indexExists(db, 'users', 'email_1');
  if (!emailIndexExists) {
    return { success: false, error: 'Unique index on "users.email" was not created' };
  }
  details.push('✓ Unique index on "users.email" exists');

  const createdAtIndexExists = await MongoDBChecks.indexExists(db, 'users', 'createdAt_-1');
  if (!createdAtIndexExists) {
    return { success: false, error: 'Index on "users.createdAt" was not created' };
  }
  details.push('✓ Index on "users.createdAt" exists');

  return { success: true, details };
}

export async function up(db, client) {
  // Create users collection with validation
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'passwordHash', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            description: 'User email address'
          },
          passwordHash: {
            bsonType: 'string',
            description: 'Hashed password'
          },
          firstName: {
            bsonType: 'string',
            description: 'First name'
          },
          lastName: {
            bsonType: 'string',
            description: 'Last name'
          },
          createdAt: {
            bsonType: 'date',
            description: 'Creation timestamp'
          },
          updatedAt: {
            bsonType: 'date',
            description: 'Last update timestamp'
          }
        }
      }
    }
  });

  // Create indexes
  const usersCollection = db.collection('users');
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ createdAt: -1 });
}

export async function down(db, client) {
  await db.collection('users').drop();
}
