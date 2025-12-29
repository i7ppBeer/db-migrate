export const up = async (db, client) => {
    await db.createCollection('users');
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
};
export const down = async (db, client) => {
    await db.collection('users').drop();
};