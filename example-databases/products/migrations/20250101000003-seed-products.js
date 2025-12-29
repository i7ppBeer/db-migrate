export const up = async (db, client) => {
    const electronics = await db.collection('categories').findOne({ slug: 'electronics' });
    await db.collection('products').insertMany([
        { sku: 'LAP-001', name: 'Laptop Pro', price: 1200, categoryId: electronics._id },
        { sku: 'PHN-002', name: 'Smart Phone X', price: 800, categoryId: electronics._id }
    ]);
};
export const down = async (db, client) => {
    await db.collection('products').deleteMany({ sku: { $in: ['LAP-001', 'PHN-002'] } });
};