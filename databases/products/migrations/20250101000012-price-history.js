export const up = async (db, client) => {
    await db.createCollection('price_history');
    const products = await db.collection('products').find().toArray();
    const history = products.map(p => ({
        productId: p._id,
        price: p.price,
        date: new Date()
    }));
    await db.collection('price_history').insertMany(history);
};
export const down = async (db, client) => {
    await db.collection('price_history').drop();
};