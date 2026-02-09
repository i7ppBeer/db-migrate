/**
 * Migration: Add profile fields to users
 * Type: Schema Migration (DDL)
 * 
 * Shows:
 * 1. Modifying existing collection schema
 * 2. Adding default values to existing documents
 * 3. Reversible schema changes
 */

export async function up(db, client) {
  const users = db.collection('users');

  // Update validation schema to include new fields
  await db.command({
    collMod: 'users',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
          },
          name: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 100
          },
          status: {
            enum: ['active', 'inactive', 'pending', 'suspended']
          },
          // New profile fields
          profile: {
            bsonType: 'object',
            properties: {
              avatar: { bsonType: ['string', 'null'] },
              bio: { bsonType: 'string', maxLength: 500 },
              website: { bsonType: ['string', 'null'] },
              location: { bsonType: ['string', 'null'] },
              preferences: {
                bsonType: 'object',
                properties: {
                  theme: { enum: ['light', 'dark', 'system'] },
                  language: { bsonType: 'string' },
                  notifications: { bsonType: 'bool' }
                }
              }
            }
          },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' }
        }
      }
    },
    validationLevel: 'moderate'
  });

  // Set default profile for existing users
  await users.updateMany(
    { profile: { $exists: false } },
    {
      $set: {
        profile: {
          avatar: null,
          bio: '',
          website: null,
          location: null,
          preferences: {
            theme: 'system',
            language: 'en',
            notifications: true
          }
        },
        updatedAt: new Date()
      }
    }
  );

  console.log('[MIGRATION] Added profile fields to users collection');
}

export async function down(db, client) {
  const users = db.collection('users');

  // Remove profile fields from all documents
  await users.updateMany(
    {},
    { $unset: { profile: '' } }
  );

  // Revert schema to original
  await db.command({
    collMod: 'users',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'createdAt'],
        properties: {
          email: {
            bsonType: 'string',
            pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
          },
          name: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 100
          },
          status: {
            enum: ['active', 'inactive', 'pending', 'suspended']
          },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' }
        }
      }
    },
    validationLevel: 'moderate'
  });

  console.log('[MIGRATION] Removed profile fields from users collection');
}
