/**
 * FAILURE CASE: Missing down() implementation
 * 
 * This migration will fail validation because:
 * 1. up() creates a collection
 * 2. down() is empty - no rollback logic
 * 
 * Expected Error: "down() is empty but up() contains operations"
 */

export async function up(db, client) {
  await db.createCollection('test_missing_down', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name'],
        properties: {
          name: { bsonType: 'string' }
        }
      }
    }
  });

  await db.collection('test_missing_down').createIndex({ name: 1 });
  
  console.log('[MIGRATION] Created test_missing_down collection');
}

export async function down(db, client) {
  // BUG: Empty down() - no rollback!
  // This will be caught by validation
}
