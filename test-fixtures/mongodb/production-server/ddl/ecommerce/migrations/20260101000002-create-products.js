/**
 * 20260101000002-create-products.js
 * Create products collection with indexes
 */

export async function up(db, client) {
  // Create products collection with validation
  await db.createCollection('products', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['sku', 'name', 'price', 'createdAt'],
        properties: {
          sku: {
            bsonType: 'string',
            description: 'Stock Keeping Unit'
          },
          name: {
            bsonType: 'string',
            description: 'Product name'
          },
          description: {
            bsonType: 'string',
            description: 'Product description'
          },
          price: {
            bsonType: 'decimal',
            description: 'Product price'
          },
          stockQuantity: {
            bsonType: 'int',
            description: 'Available stock quantity'
          },
          categoryId: {
            bsonType: 'objectId',
            description: 'Category reference'
          },
          isActive: {
            bsonType: 'bool',
            description: 'Product active status'
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
  const productsCollection = db.collection('products');
  await productsCollection.createIndex({ sku: 1 }, { unique: true });
  await productsCollection.createIndex({ categoryId: 1 });
  await productsCollection.createIndex({ isActive: 1, createdAt: -1 });
  await productsCollection.createIndex({ name: 'text', description: 'text' });
}

export async function down(db, client) {
  await db.collection('products').drop();
}
