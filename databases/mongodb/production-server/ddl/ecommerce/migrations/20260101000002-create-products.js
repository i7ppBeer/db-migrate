/**
 * 20260101000002-create-products.js
 * Create products collection with indexes
 */

import { MongoDBChecks } from '../../../../../src/core/sanity-checker.js';

/**
 * Pre-Check: Verify users collection exists and products does not
 */
export async function preCheck({ db }) {
  const details = [];

  const usersExists = await MongoDBChecks.collectionExists(db, 'users');
  if (!usersExists) {
    return { success: false, error: 'Collection "users" does not exist. Run create-users migration first.' };
  }
  details.push('✓ Collection "users" exists');

  const productsExists = await MongoDBChecks.collectionExists(db, 'products');
  if (productsExists) {
    return { success: false, error: 'Collection "products" already exists. Migration may have been applied.' };
  }
  details.push('✓ Collection "products" does not exist yet');

  return { success: true, details };
}

/**
 * Post-Check: Verify products collection and indexes were created
 */
export async function postCheck({ db }) {
  const details = [];

  const collectionExists = await MongoDBChecks.collectionExists(db, 'products');
  if (!collectionExists) {
    return { success: false, error: 'Collection "products" was not created' };
  }
  details.push('✓ Collection "products" exists');

  const skuIndexExists = await MongoDBChecks.indexExists(db, 'products', 'sku_1');
  if (!skuIndexExists) {
    return { success: false, error: 'Unique index on "products.sku" was not created' };
  }
  details.push('✓ Unique index on "products.sku" exists');

  const categoryIndexExists = await MongoDBChecks.indexExists(db, 'products', 'categoryId_1');
  if (!categoryIndexExists) {
    return { success: false, error: 'Index on "products.categoryId" was not created' };
  }
  details.push('✓ Index on "products.categoryId" exists');

  return { success: true, details };
}

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
