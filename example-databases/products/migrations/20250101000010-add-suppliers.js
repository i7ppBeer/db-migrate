export const up = async (db, client) => {
    await db.createCollection('suppliers');
    await db.collection('suppliers').insertOne({ name: 'TechDistro Inc.', contact: 'sales@techdistro.com' });
};
export const down = async (db, client) => {
    await db.collection('suppliers').drop();
};