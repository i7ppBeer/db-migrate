export const up = async (db, client) => {
    await db.collection('audit_log').insertOne({ action: 'MIGRATION_BATCH', date: new Date() });
};
export const down = async (db, client) => {
    // Capped collections don't support deleteMany, so we skip or drop/recreate in real scenarios
    // For this demo, we do nothing
};