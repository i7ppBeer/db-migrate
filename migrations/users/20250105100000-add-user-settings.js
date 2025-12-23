// Add user settings collection
export async function up(db, client) {
  console.log('Creating user_settings collection...');
  
  await db.createCollection('user_settings', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'theme', 'language', 'updatedAt'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          theme: {
            bsonType: 'string',
            enum: ['light', 'dark', 'auto']
          },
          language: {
            bsonType: 'string',
            pattern: '^[a-z]{2}(-[A-Z]{2})?$'
          },
          notifications: {
            bsonType: 'object',
            properties: {
              email: { bsonType: 'bool' },
              push: { bsonType: 'bool' },
              sms: { bsonType: 'bool' }
            }
          },
          privacy: {
            bsonType: 'object',
            properties: {
              profilePublic: { bsonType: 'bool' },
              showEmail: { bsonType: 'bool' }
            }
          },
          updatedAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('user_settings').createIndex({ userId: 1 }, { unique: true });
  console.log('✅ User settings collection created');
}

export async function down(db, client) {
  await db.collection('user_settings').drop();
  console.log('✅ User settings collection dropped');
}
