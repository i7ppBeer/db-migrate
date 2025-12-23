// Example migration for Orders database
export async function up(db, client) {
  console.log('Creating orders collection...');
  
  await db.createCollection('orders', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'totalAmount', 'status', 'createdAt'],
        properties: {
          userId: {
            bsonType: 'objectId',
            description: 'must be a valid user ID'
          },
          totalAmount: {
            bsonType: 'number',
            minimum: 0,
            description: 'must be a positive number'
          },
          status: {
            enum: ['pending', 'processing', 'completed', 'cancelled'],
            description: 'must be one of: pending, processing, completed, cancelled'
          },
          createdAt: {
            bsonType: 'date',
            description: 'must be a date'
          }
        }
      }
    }
  });
  
  await db.collection('orders').createIndex({ userId: 1 });
  await db.collection('orders').createIndex({ status: 1 });
  await db.collection('orders').createIndex({ createdAt: -1 });
  
  console.log('✅ Orders collection created successfully');
}

export async function down(db, client) {
  console.log('Dropping orders collection...');
  await db.collection('orders').drop();
  console.log('✅ Orders collection dropped');
}
