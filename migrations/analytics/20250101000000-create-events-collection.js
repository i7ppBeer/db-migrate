// Example migration for Analytics database
export async function up(db, client) {
  console.log('Creating events collection...');
  
  await db.createCollection('events', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['eventType', 'userId', 'timestamp', 'data'],
        properties: {
          eventType: {
            bsonType: 'string',
            description: 'must be a string'
          },
          userId: {
            bsonType: 'objectId',
            description: 'must be a valid user ID'
          },
          timestamp: {
            bsonType: 'date',
            description: 'must be a date'
          },
          data: {
            bsonType: 'object',
            description: 'event data object'
          }
        }
      }
    }
  });
  
  await db.collection('events').createIndex({ userId: 1 });
  await db.collection('events').createIndex({ eventType: 1 });
  await db.collection('events').createIndex({ timestamp: -1 });
  await db.collection('events').createIndex({ userId: 1, timestamp: -1 });
  
  console.log('✅ Events collection created successfully');
}

export async function down(db, client) {
  console.log('Dropping events collection...');
  await db.collection('events').drop();
  console.log('✅ Events collection dropped');
}
