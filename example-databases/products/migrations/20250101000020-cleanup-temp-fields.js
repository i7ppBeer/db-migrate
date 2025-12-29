export const up = async (db, client) => {
    // Hypothetical cleanup
    await db.collection('products').updateMany({}, { $unset: { temp_import_id: "" } });
};
export const down = async (db, client) => {
    // Cannot restore temp fields easily
};