// Add user profiles collection
export async function up(db, client) {
  console.log('Creating user_profiles collection...');
  
  await db.createCollection('user_profiles', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'firstName', 'lastName', 'createdAt'],
        properties: {
          userId: {
            bsonType: 'objectId',
            description: 'Reference to users collection'
          },
          firstName: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 50
          },
          lastName: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 50
          },
          avatar: {
            bsonType: 'string',
            description: 'Avatar URL'
          },
          bio: {
            bsonType: 'string',
            maxLength: 500
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('user_profiles').createIndex({ userId: 1 }, { unique: true });
  console.log('✅ User profiles collection created');
}

export async function down(db, client) {
  await db.collection('user_profiles').drop();
  console.log('✅ User profiles collection dropped');
}
