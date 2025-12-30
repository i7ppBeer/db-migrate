export const up = async (db, client) => {
    await db.collection('products').updateOne({ sku: 'LAP-001' }, { $push: { tags: 'tech' } });
};
export const down = async (db, client) => {
    await db.collection('products').updateOne({ sku: 'LAP-001' }, { $pull: { tags: 'tech' } });
};