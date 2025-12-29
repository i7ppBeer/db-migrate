export const up = async (db, client) => {
    await db.collection('products').updateMany({}, { $set: { tags: [] } });
};
export const down = async (db, client) => {
    await db.collection('products').updateMany({}, { $unset: { tags: "" } });
};