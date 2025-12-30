export const up = async (db, client) => {
    await db.collection('discounts').insertMany([
        { code: 'WELCOME10', percent: 10 },
        { code: 'SUMMER20', percent: 20 }
    ]);
};
export const down = async (db, client) => {
    await db.collection('discounts').deleteMany({});
};