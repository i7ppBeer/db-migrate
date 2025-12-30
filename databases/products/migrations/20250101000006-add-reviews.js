export const up = async (db, client) => {
    await db.createCollection('reviews');
    await db.collection('reviews').createIndex({ productId: 1 });
};
export const down = async (db, client) => {
    await db.collection('reviews').drop();
};