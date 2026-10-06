export async function up(db) {
  await db.createCollection('customers');
  await db.collection('customers').createIndex({ email: 1 }, { unique: true, name: 'idx_customers_email' });
}

export async function down(db) {
  await db.collection('customers').drop();
}
