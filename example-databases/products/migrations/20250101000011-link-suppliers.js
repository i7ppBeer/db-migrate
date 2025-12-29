export const up = async (db, client) => {
    const supplier = await db.collection('suppliers').findOne({ name: 'TechDistro Inc.' });
    await db.collection('products').updateMany({}, { $set: { supplierId: supplier._id } });
};
export const down = async (db, client) => {
    await db.collection('products').updateMany({}, { $unset: { supplierId: "" } });
};