// Add order payments collection
export async function up(db, client) {
  console.log('Creating order_payments collection...');
  
  await db.createCollection('order_payments', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['orderId', 'amount', 'method', 'status', 'createdAt'],
        properties: {
          orderId: {
            bsonType: 'objectId'
          },
          amount: {
            bsonType: 'number',
            minimum: 0
          },
          method: {
            bsonType: 'string',
            enum: ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'cash']
          },
          status: {
            bsonType: 'string',
            enum: ['pending', 'processing', 'completed', 'failed', 'refunded']
          },
          transactionId: {
            bsonType: 'string'
          },
          metadata: {
            bsonType: 'object'
          },
          createdAt: {
            bsonType: 'date'
          },
          updatedAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('order_payments').createIndex({ orderId: 1 });
  await db.collection('order_payments').createIndex({ status: 1 });
  await db.collection('order_payments').createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  console.log('✅ Order payments collection created');
}

export async function down(db, client) {
  await db.collection('order_payments').drop();
  console.log('✅ Order payments collection dropped');
}
