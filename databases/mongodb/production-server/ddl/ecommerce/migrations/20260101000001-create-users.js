/**
 * 20260101000001-create-users.js
 * Create users collection with indexes
 */

export async function up(db, client) {
  // Create users collection with validation
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'passwordHash', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            description: 'User email address'
          },
          passwordHash: {
            bsonType: 'string',
            description: 'Hashed password'
          },
          firstName: {
            bsonType: 'string',
            description: 'First name'
          },
          lastName: {
            bsonType: 'string',
            description: 'Last name'
          },
          createdAt: {
            bsonType: 'date',
            description: 'Creation timestamp'
          },
          updatedAt: {
            bsonType: 'date',
            description: 'Last update timestamp'
          }
        }
      }
    }
  });

  // Create indexes
  const usersCollection = db.collection('users');
  await usersCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ createdAt: -1 });
}

export async function down(db, client) {
  await db.collection('users').drop();
}
