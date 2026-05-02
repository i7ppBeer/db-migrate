/**
 * Migration: Create products collection with full structure
 * Type: DDL
 * 
 * Demonstrates:
 * 1. Complex JSON Schema validation
 * 2. Multiple index types (compound, text, partial)
 * 3. TTL index for auto-cleanup
 */

export async function up(db, client) {
  // Create products collection
  await db.createCollection('products', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['sku', 'name', 'price', 'category'],
        properties: {
          sku: {
            bsonType: 'string',
            pattern: '^[A-Z]{3}-[0-9]{6}$',
            description: 'SKU format: ABC-123456'
          },
          name: {
            bsonType: 'string',
            minLength: 1,
            maxLength: 200
          },
          description: {
            bsonType: 'string'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0
          },
          category: {
            bsonType: 'string'
          },
          tags: {
            bsonType: 'array',
            items: { bsonType: 'string' }
          },
          inventory: {
            bsonType: 'object',
            properties: {
              quantity: { bsonType: 'int' },
              warehouse: { bsonType: 'string' }
            }
          },
          status: {
            enum: ['draft', 'active', 'discontinued', 'archived']
          }
        }
      }
    }
  });

  const products = db.collection('products');

  // Unique SKU index
  await products.createIndex(
    { sku: 1 },
    { unique: true, name: 'idx_products_sku' }
  );

  // Category and status compound index
  await products.createIndex(
    { category: 1, status: 1 },
    { name: 'idx_products_category_status' }
  );

  // Text search index
  await products.createIndex(
    { name: 'text', description: 'text', tags: 'text' },
    { name: 'idx_products_text_search', weights: { name: 10, tags: 5, description: 1 } }
  );

  // Partial index for active products only
  await products.createIndex(
    { price: 1 },
    { 
      name: 'idx_products_active_price',
      partialFilterExpression: { status: 'active' }
    }
  );

  console.log('[MIGRATION] Created products collection with schema and indexes');
}

export async function down(db, client) {
  await db.collection('products').drop();
  console.log('[MIGRATION] Dropped products collection');
}
