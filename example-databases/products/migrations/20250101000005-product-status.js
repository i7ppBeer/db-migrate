export const up = async (db, client) => {
    await db.collection('products').updateMany({}, { $set: { status: 'active' } });
};
export const down = async (db, client) => {
    await db.collection('products').updateMany({}, { $unset: { status: "" } });
};