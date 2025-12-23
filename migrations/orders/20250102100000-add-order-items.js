// Add order items collection
export async function up(db, client) {
  console.log('Creating order_items collection...');
  
  await db.createCollection('order_items', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'productId', 'quantity', 'price', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'objectId'
          },
          productId: {
            bsonType: 'objectId'
          },
          quantity: {
            bsonType: 'int',
            minimum: 1
          },
          price: {
            bsonType: 'number',
            minimum: 0
          },
          discount: {
            bsonType: 'number',
            minimum: 0,
            maximum: 100
          },
          subtotal: {
            bsonType: 'number',
            minimum: 0
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('order_items').createIndex({ orderId: 1 });
  await db.collection('order_items').createIndex({ productId: 1 });
  console.log('✅ Order items collection created');
}

export async function down(db, client) {
  await db.collection('order_items').drop();
  console.log('✅ Order items collection dropped');
}
