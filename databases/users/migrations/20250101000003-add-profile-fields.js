export const up = async (db, client) => {
    await db.collection('users').updateMany({}, { $set: { profile: { bio: '', avatar: null } } });
};
export const down = async (db, client) => {
    await db.collection('users').updateMany({}, { $unset: { profile: "" } });
};