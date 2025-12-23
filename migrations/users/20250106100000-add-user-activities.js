// Add user activities collection
export async function up(db, client) {
  console.log('Creating user_activities collection...');
  
  await db.createCollection('user_activities', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'action', 'timestamp'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          action: {
            bsonType: 'string',
            enum: ['login', 'logout', 'profile_update', 'password_change', 'settings_update']
          },
          metadata: {
            bsonType: 'object'
          },
          ipAddress: {
            bsonType: 'string'
          },
          timestamp: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('user_activities').createIndex({ userId: 1, timestamp: -1 });
  await db.collection('user_activities').createIndex({ action: 1 });
  console.log('✅ User activities collection created');
}

export async function down(db, client) {
  await db.collection('user_activities').drop();
  console.log('✅ User activities collection dropped');
}
