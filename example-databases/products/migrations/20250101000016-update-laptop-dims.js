export const up = async (db, client) => {
    await db.collection('products').updateOne(
        { sku: 'LAP-001' }, 
        { $set: { dimensions: { width: 35, height: 2, depth: 24, unit: 'cm' } } }
    );
};
export const down = async (db, client) => {
    await db.collection('products').updateOne(
        { sku: 'LAP-001' }, 
        { $set: { dimensions: { width: 0, height: 0, depth: 0, unit: 'cm' } } }
    );
};