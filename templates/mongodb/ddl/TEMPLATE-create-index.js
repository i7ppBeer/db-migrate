// Rename to <timestamp>-add-orders-customer-created-index.js before use.

export async function up(db, client) {
  await db.collection('orders').createIndex(
    { customerId: 1, createdAt: -1 },
    { name: 'idx_orders_customerId_createdAt' }
  );
}

export async function down(db, client) {
  await db.collection('orders').dropIndex('idx_orders_customerId_createdAt');
}
