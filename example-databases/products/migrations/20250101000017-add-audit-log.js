export const up = async (db, client) => {
    await db.createCollection('audit_log', { capped: true, size: 5242880, max: 5000 });
};
export const down = async (db, client) => {
    await db.collection('audit_log').drop();
};