// @expect-sanity: rollback
/**
 * The postCheck requires a unique index on orderNo, but up() forgets to
 * create it — the kind of mistake a sanity check exists to catch. With
 * --sanity-check the migration must be rolled back (down() runs) and not
 * recorded as applied.
 */

export async function preCheck(db) {
  const existing = await db.listCollections({ name: 'sanity_orders' }).toArray();
  return existing.length === 0
    ? { success: true }
    : { success: false, error: 'sanity_orders already exists' };
}

export async function up(db) {
  await db.createCollection('sanity_orders');
  await db.collection('sanity_orders').insertOne({ orderNo: 'A-0001' });
}

export async function postCheck(db) {
  const indexes = await db.collection('sanity_orders').indexes();
  const ok = indexes.some(i => i.unique && i.key && i.key.orderNo === 1);
  return ok
    ? { success: true }
    : { success: false, error: 'expected a unique index on sanity_orders.orderNo' };
}

export async function down(db) {
  await db.collection('sanity_orders').drop();
}
