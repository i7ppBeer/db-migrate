export const up = async (db, client) => {
    await db.collection('products').updateMany({}, { 
        $set: { dimensions: { width: 0, height: 0, depth: 0, unit: 'cm' } } 
    });
};
export const down = async (db, client) => {
    await db.collection('products').updateMany({}, { $unset: { dimensions: "" } });
};