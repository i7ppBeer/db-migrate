export const up = async (db, client) => {
    await db.createCollection('products');
    await db.collection('products').createIndex({ sku: 1 }, { unique: true });
};
export const down = async (db, client) => {
    await db.collection('products').drop();
};