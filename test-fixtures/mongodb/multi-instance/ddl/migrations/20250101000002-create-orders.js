/**
 * Migration: Create orders collection for multi-instance test
 */

export async function up(db) {
  await db.createCollection('orders', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'totalAmount', 'status'],
        properties: {
          userId: { bsonType: 'objectId' },
          totalAmount: { bsonType: 'decimal' },
          status: { enum: ['pending', 'processing', 'completed', 'cancelled'] },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' }
        }
      }
    }
  });
  
  await db.collection('orders').createIndex({ userId: 1 });
  await db.collection('orders').createIndex({ status: 1 });
  
  console.log('[MIGRATION] Created orders collection');
}

export async function down(db) {
  await db.collection('orders').drop();
  console.log('[MIGRATION] Dropped orders collection');
}
