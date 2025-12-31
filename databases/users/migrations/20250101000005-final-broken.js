export const up = async (db, client) => {
    // This migration is INTENTIONALLY BROKEN to test rollback
    throw new Error('Simulated migration failure for testing rollback - final migration');
};

export const down = async (db, client) => {
    console.log('Rolling back final broken migration (nothing to do)');
};
