// Add user sessions collection
export async function up(db, client) {
  console.log('Creating sessions collection...');
  
  await db.createCollection('sessions', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['userId', 'token', 'expiresAt', 'createdAt'],
        properties: {
          userId: {
            bsonType: 'objectId'
          },
          token: {
            bsonType: 'string',
            minLength: 32
          },
          ipAddress: {
            bsonType: 'string'
          },
          userAgent: {
            bsonType: 'string'
          },
          expiresAt: {
            bsonType: 'date'
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('sessions').createIndex({ userId: 1 });
  await db.collection('sessions').createIndex({ token: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('✅ Sessions collection created');
}

export async function down(db, client) {
  await db.collection('sessions').drop();
  console.log('✅ Sessions collection dropped');
}
