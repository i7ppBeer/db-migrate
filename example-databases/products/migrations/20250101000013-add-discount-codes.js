export const up = async (db, client) => {
    await db.createCollection('discounts');
    await db.collection('discounts').createIndex({ code: 1 }, { unique: true });
};
export const down = async (db, client) => {
    await db.collection('discounts').drop();
};