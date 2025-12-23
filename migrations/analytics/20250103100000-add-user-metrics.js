// Add user metrics collection
export async function up(db, client) {
  console.log('Creating user_metrics collection...');
  
  await db.createCollection('user_metrics', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'date', 'metrics'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          date: {
            bsonType: 'date'
          },
          metrics: {
            bsonType: 'object',
            properties: {
              sessions: { bsonType: 'int', minimum: 0 },
              pageViews: { bsonType: 'int', minimum: 0 },
              avgSessionDuration: { bsonType: 'int', minimum: 0 },
              bounceRate: { bsonType: 'number', minimum: 0, maximum: 100 }
            }
          }
        }
      }
    }
  });
  
  await db.collection('user_metrics').createIndex({ userId: 1, date: -1 });
  await db.collection('user_metrics').createIndex({ date: -1 });
  console.log('✅ User metrics collection created');
}

export async function down(db, client) {
  await db.collection('user_metrics').drop();
  console.log('✅ User metrics collection dropped');
}
