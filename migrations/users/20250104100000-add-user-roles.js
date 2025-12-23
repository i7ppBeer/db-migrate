// Add roles collection
export async function up(db, client) {
  console.log('Creating roles collection...');
  
  await db.createCollection('roles', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'permissions', 'createdAt'],
        properties: {
          name: {
            bsonType: 'string',
            enum: ['admin', 'moderator', 'user', 'guest']
          },
          permissions: {
            bsonType: 'array',
            items: {
              bsonType: 'string'
            }
          },
          description: {
            bsonType: 'string'
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    }
  });
  
  await db.collection('roles').createIndex({ name: 1 }, { unique: true });
  
  // Insert default roles
  await db.collection('roles').insertMany([
    { name: 'admin', permissions: ['*'], description: 'Administrator', createdAt: new Date() },
    { name: 'moderator', permissions: ['read', 'write', 'moderate'], description: 'Moderator', createdAt: new Date() },
    { name: 'user', permissions: ['read', 'write'], description: 'Regular user', createdAt: new Date() },
    { name: 'guest', permissions: ['read'], description: 'Guest user', createdAt: new Date() }
  ]);
  
  console.log('✅ Roles collection created with default roles');
}

export async function down(db, client) {
  await db.collection('roles').drop();
  console.log('✅ Roles collection dropped');
}
