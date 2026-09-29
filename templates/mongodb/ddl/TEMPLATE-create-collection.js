// Rename to <timestamp>-create-orders.js (or run:
//   node src/cli.js create create-orders -c <ddl-config>
// and paste this content in) before use.

export async function up(db, client) {
  const exists = await db.listCollections({ name: 'orders' }).toArray();
  if (exists.length === 0) {
    await db.createCollection('orders', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['customerId', 'totalAmount', 'status'],
          properties: {
            customerId: { bsonType: 'objectId' },
            totalAmount: { bsonType: 'decimal' },
            status: { enum: ['pending', 'paid', 'shipped', 'completed', 'cancelled'] }
          }
        }
      }
    });
  }

  await db.collection('orders').createIndex({ customerId: 1 }, { name: 'idx_customerId' });
  await db.collection('orders').createIndex({ status: 1 }, { name: 'idx_status' });
}

export async function down(db, client) {
  await db.collection('orders').drop();
}
