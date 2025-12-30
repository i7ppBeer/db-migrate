export const up = async (db, client) => {
    await db.collection('users').insertMany([
        { username: 'alice', email: 'alice@example.com', role: 'user' },
        { username: 'bob', email: 'bob@example.com', role: 'admin' }
    ]);
};
export const down = async (db, client) => {
    await db.collection('users').deleteMany({ email: { $in: ['alice@example.com', 'bob@example.com'] } });
};