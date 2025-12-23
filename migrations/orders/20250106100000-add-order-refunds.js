// Add order refunds collection
export async function up(db, client) {
  console.log('Creating order_refunds collection...');
  
  await db.createCollection('order_refunds', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'amount', 'reason', 'status', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'objectId'
          },
          amount: {
            bsonType: 'number',
            minimum: 0
          },
          reason: {
            bsonType: 'string',
            enum: ['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other']
          },
          description: {
            bsonType: 'string',
            maxLength: 500
          },
          status: {
            bsonType: 'string',
            enum: ['pending', 'approved', 'rejected', 'processing', 'completed']
          },
          processedBy: {
            bsonType: 'objectId'
          },
          createdAt: {
            bsonType: 'date'
          },
          processedAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('order_refunds').createIndex({ orderId: 1 });
  await db.collection('order_refunds').createIndex({ status: 1 });
  await db.collection('order_refunds').createIndex({ createdAt: -1 });
  console.log('✅ Order refunds collection created');
}

export async function down(db, client) {
  await db.collection('order_refunds').drop();
  console.log('✅ Order refunds collection dropped');
}
