/**
 * FAILURE CASE: Non-idempotent deleteMany without filter
 * 
 * This migration has issues:
 * 1. deleteMany({}) removes ALL documents
 * 2. This is not reversible - data is lost
 * 3. Running twice has different effects
 * 
 * Expected Warning: "Non-idempotent operation: deleteMany with empty filter"
 */

export async function up(db, client) {
  const products = db.collection('products');
  
  // This looks innocent but is dangerous
  // If there's bad data, just delete everything!
  await products.deleteMany({});  // DANGER: Deletes ALL products
  
  // Now insert new data
  await products.insertMany([
    { name: 'Product 1', price: 100 },
    { name: 'Product 2', price: 200 }
  ]);
}

export async function down(db, client) {
  // How do you restore deleted products?
  // You can't! The data is gone forever.
  await db.collection('products').deleteMany({});
}
