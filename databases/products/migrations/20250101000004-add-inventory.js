export const up = async (db, client) => {
    await db.createCollection('inventory');
    const products = await db.collection('products').find().toArray();
    const inventoryItems = products.map(p => ({
        productId: p._id,
        quantity: 100,
        warehouse: 'Main'
    }));
    await db.collection('inventory').insertMany(inventoryItems);
};
export const down = async (db, client) => {
    await db.collection('inventory').drop();
};