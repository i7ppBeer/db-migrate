// Add error logs collection
export async function up(db, client) {
  console.log('Creating error_logs collection...');
  
  await db.createCollection('error_logs', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['level', 'message', 'timestamp'],
        properties: {
          level: {
            bsonType: 'string',
            enum: ['error', 'warning', 'critical']
          },
          message: {
            bsonType: 'string'
          },
          stack: {
            bsonType: 'string'
          },
          userId: {
            bsonType: 'objectId'
          },
          context: {
            bsonType: 'object'
          },
          resolved: {
            bsonType: 'bool'
          },
          timestamp: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('error_logs').createIndex({ level: 1, timestamp: -1 });
  await db.collection('error_logs').createIndex({ userId: 1 });
  await db.collection('error_logs').createIndex({ resolved: 1 });
  console.log('✅ Error logs collection created');
}

export async function down(db, client) {
  await db.collection('error_logs').drop();
  console.log('✅ Error logs collection dropped');
}
