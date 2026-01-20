/**
 * Migration: Create orders collection with references
 * Type: DDL
 * 
 * Shows:
 * 1. Document references (userId, productIds)
 * 2. Nested object validation
 * 3. TTL index for old order cleanup
 */

export async function up(db, client) {
  await db.createCollection('orders', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'userId', 'items', 'total', 'status', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'string',
            pattern: '^ORD-[0-9]{8}-[A-Z0-9]{6}$'
          },
          userId: {
            bsonType: 'string'
          },
          items: {
            bsonType: 'array',
            minItems: 1,
            items: {
              bsonType: 'object',
              required: ['productSku', 'quantity', 'unitPrice'],
              properties: {
                productSku: { bsonType: 'string' },
                productName: { bsonType: 'string' },
                quantity: { bsonType: 'int', minimum: 1 },
                unitPrice: { bsonType: 'decimal' }
              }
            }
          },
          total: {
            bsonType: 'decimal',
            minimum: 0
          },
          status: {
            enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']
          },
          shipping: {
            bsonType: 'object',
            properties: {
              address: { bsonType: 'string' },
              city: { bsonType: 'string' },
              country: { bsonType: 'string' },
              zipCode: { bsonType: 'string' }
            }
          },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
          completedAt: { bsonType: 'date' }
        }
      }
    }
  });

  const orders = db.collection('orders');

  // Unique order ID
  await orders.createIndex(
    { orderId: 1 },
    { unique: true, name: 'idx_orders_orderId' }
  );

  // User's orders
  await orders.createIndex(
    { userId: 1, createdAt: -1 },
    { name: 'idx_orders_user_date' }
  );

  // Status tracking
  await orders.createIndex(
    { status: 1, createdAt: -1 },
    { name: 'idx_orders_status' }
  );

  // TTL: Archive completed orders after 2 years
  await orders.createIndex(
    { completedAt: 1 },
    { 
      name: 'idx_orders_ttl_archive',
      expireAfterSeconds: 63072000,  // 2 years
      partialFilterExpression: { 
        status: { $in: ['delivered', 'cancelled', 'refunded'] }
      }
    }
  );

  console.log('[MIGRATION] Created orders collection');
}

export async function down(db, client) {
  await db.collection('orders').drop();
  console.log('[MIGRATION] Dropped orders collection');
}
