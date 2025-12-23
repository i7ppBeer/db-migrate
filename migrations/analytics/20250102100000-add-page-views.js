// Add page views collection
export async function up(db, client) {
  console.log('Creating page_views collection...');
  
  await db.createCollection('page_views', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'page', 'timestamp'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          page: {
            bsonType: 'string'
          },
          referrer: {
            bsonType: 'string'
          },
          duration: {
            bsonType: 'int',
            minimum: 0
          },
          timestamp: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('page_views').createIndex({ userId: 1, timestamp: -1 });
  await db.collection('page_views').createIndex({ page: 1 });
  await db.collection('page_views').createIndex({ timestamp: -1 });
  console.log('✅ Page views collection created');
}

export async function down(db, client) {
  await db.collection('page_views').drop();
  console.log('✅ Page views collection dropped');
}
