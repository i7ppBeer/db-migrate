export const up = async (db, client) => {
    await db.createCollection('categories');
    await db.collection('categories').insertMany([
        { name: 'Electronics', slug: 'electronics' },
        { name: 'Books', slug: 'books' },
        { name: 'Clothing', slug: 'clothing' }
    ]);
};
export const down = async (db, client) => {
    await db.collection('categories').drop();
};