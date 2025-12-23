// Add order shipping collection
export async function up(db, client) {
  console.log('Creating order_shipping collection...');
  
  await db.createCollection('order_shipping', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'address', 'method', 'status', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'objectId'
          },
          address: {
            bsonType: 'object',
            required: ['street', 'city', 'country', 'zipCode'],
            properties: {
              street: { bsonType: 'string' },
              city: { bsonType: 'string' },
              state: { bsonType: 'string' },
              country: { bsonType: 'string' },
              zipCode: { bsonType: 'string' }
            }
          },
          method: {
            bsonType: 'string',
            enum: ['standard', 'express', 'overnight', 'pickup']
          },
          status: {
            bsonType: 'string',
            enum: ['pending', 'processing', 'shipped', 'in_transit', 'delivered', 'cancelled']
          },
          trackingNumber: {
            bsonType: 'string'
          },
          carrier: {
            bsonType: 'string'
          },
          estimatedDelivery: {
            bsonType: 'date'
          },
          actualDelivery: {
            bsonType: 'date'
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('order_shipping').createIndex({ orderId: 1 });
  await db.collection('order_shipping').createIndex({ status: 1 });
  await db.collection('order_shipping').createIndex({ trackingNumber: 1 }, { unique: true, sparse: true });
  console.log('✅ Order shipping collection created');
}

export async function down(db, client) {
  await db.collection('order_shipping').drop();
  console.log('✅ Order shipping collection dropped');
}
