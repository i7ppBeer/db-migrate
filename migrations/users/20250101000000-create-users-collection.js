// Example migration for Users database
export async function up(db, client) {
  console.log('Creating users collection...');
  
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'username', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
            description: 'must be a valid email address'
          },
          username: {
            bsonType: 'string',
            minLength: 3,
            maxLength: 30,
            description: 'must be a string between 3-30 characters'
          },
          createdAt: {
            bsonType: 'date',
            description: 'must be a date'
          }
        }
      }
    }
  });
  
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  
  console.log('✅ Users collection created successfully');
}

export async function down(db, client) {
  console.log('Dropping users collection...');
  await db.collection('users').drop();
  console.log('✅ Users collection dropped');
}
