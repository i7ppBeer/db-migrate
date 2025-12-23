// Add performance metrics collection
export async function up(db, client) {
  console.log('Creating performance_metrics collection...');
  
  await db.createCollection('performance_metrics', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['endpoint', 'method', 'duration', 'timestamp'],
        properties: {
          endpoint: {
            bsonType: 'string'
          },
          method: {
            bsonType: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
          },
          duration: {
            bsonType: 'int',
            minimum: 0
          },
          statusCode: {
            bsonType: 'int',
            minimum: 100,
            maximum: 599
          },
          userId: {
            bsonType: 'objectId'
          },
          memory: {
            bsonType: 'object',
            properties: {
              heapUsed: { bsonType: 'number' },
              heapTotal: { bsonType: 'number' }
            }
          },
          timestamp: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('performance_metrics').createIndex({ endpoint: 1, timestamp: -1 });
  await db.collection('performance_metrics').createIndex({ duration: -1 });
  await db.collection('performance_metrics').createIndex({ timestamp: -1 });
  console.log('✅ Performance metrics collection created');
}

export async function down(db, client) {
  await db.collection('performance_metrics').drop();
  console.log('✅ Performance metrics collection dropped');
}
