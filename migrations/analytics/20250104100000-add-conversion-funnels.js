// Add conversion funnels collection
export async function up(db, client) {
  console.log('Creating conversion_funnels collection...');
  
  await db.createCollection('conversion_funnels', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'funnel', 'step', 'timestamp'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          funnel: {
            bsonType: 'string',
            enum: ['signup', 'checkout', 'onboarding', 'upgrade']
          },
          step: {
            bsonType: 'string'
          },
          completed: {
            bsonType: 'bool'
          },
          metadata: {
            bsonType: 'object'
          },
          timestamp: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('conversion_funnels').createIndex({ userId: 1, funnel: 1 });
  await db.collection('conversion_funnels').createIndex({ funnel: 1, timestamp: -1 });
  console.log('✅ Conversion funnels collection created');
}

export async function down(db, client) {
  await db.collection('conversion_funnels').drop();
  console.log('✅ Conversion funnels collection dropped');
}
