export const up = async (db, client) => {
    await db.createCollection('products_archive');
};
export const down = async (db, client) => {
    await db.collection('products_archive').drop();
};