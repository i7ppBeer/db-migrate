export const up = async (db, client) => {
    const product = await db.collection('products').findOne({ sku: 'LAP-001' });
    await db.collection('reviews').insertOne({
        productId: product._id,
        user: 'user1',
        rating: 5,
        comment: 'Great laptop!'
    });
};
export const down = async (db, client) => {
    await db.collection('reviews').deleteMany({ user: 'user1' });
};