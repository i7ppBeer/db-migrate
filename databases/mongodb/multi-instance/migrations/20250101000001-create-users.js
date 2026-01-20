/**
 * Migration: Create users collection with schema validation
 * Type: DDL (Data Definition Language)
 * 
 * This is a proper migration example showing:
 * 1. Creating collection with schema validation
 * 2. Creating indexes
 * 3. Proper down() that reverses up()
 */

export async function up(db, client) {
  // Create users collection with JSON Schema validation
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
            description: 'Email address - required and must be valid format'
          },
          name: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'User display name'
          },
          status: {
            enum: ['active', 'inactive', 'pending', 'suspended'],
            description: 'User status'
          },
          createdAt: {
            bsonType: 'date',
            description: 'Creation timestamp - required'
          },
          updatedAt: {
            bsonType: 'date',
            description: 'Last update timestamp'
          }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'error'
  });

  // Create unique index on email
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, name: 'idx_users_email' }
  );

  // Create index for status queries
  await db.collection('users').createIndex(
    { status: 1, createdAt: -1 },
    { name: 'idx_users_status_created' }
  );

  console.log('[MIGRATION] Created users collection with validation and indexes');
}

export async function down(db, client) {
  // Drop the collection (this also drops all indexes)
  await db.collection('users').drop();
  
  console.log('[MIGRATION] Dropped users collection');
}
