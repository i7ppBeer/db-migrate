// Add order reviews collection
export async function up(db, client) {
  console.log('Creating order_reviews collection...');
  
  await db.createCollection('order_reviews', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'userId', 'rating', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'objectId'
          },
          userId: {
            bsonType: 'objectId'
          },
          rating: {
            bsonType: 'int',
            minimum: 1,
            maximum: 5
          },
          title: {
            bsonType: 'string',
            maxLength: 100
          },
          comment: {
            bsonType: 'string',
            maxLength: 1000
          },
          images: {
            bsonType: 'array',
            items: {
              bsonType: 'string'
            }
          },
          verified: {
            bsonType: 'bool'
          },
          helpful: {
            bsonType: 'int',
            minimum: 0
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('order_reviews').createIndex({ orderId: 1 });
  await db.collection('order_reviews').createIndex({ userId: 1 });
  await db.collection('order_reviews').createIndex({ rating: 1 });
  console.log('✅ Order reviews collection created');
}

export async function down(db, client) {
  await db.collection('order_reviews').drop();
  console.log('✅ Order reviews collection dropped');
}
