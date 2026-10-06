export async function up(db) {
  await db.collection('customers').createIndex({ name: 1 }, { name: 'idx_customers_name' });
}

export async function down(db) {
  await db.collection('customers').dropIndex('idx_customers_name');
}
