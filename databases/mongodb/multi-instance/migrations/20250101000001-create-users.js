/**
 * Migration: Create shared users collection for multi-instance test
 */

export async function up(db) {
  // Create users collection with validation
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'name'],
        properties: {
          email: { bsonType: 'string' },
          name: { bsonType: 'string' },
          createdAt: { bsonType: 'date' }
        }
      }
    }
  });
  
  // Create unique index on email
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  
  console.log('[MIGRATION] Created users collection');
}

export async function down(db) {
  await db.collection('users').drop();
  console.log('[MIGRATION] Dropped users collection');
}
