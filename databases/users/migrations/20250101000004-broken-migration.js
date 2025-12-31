export const up = async (db, client) => {
    // This migration is INTENTIONALLY BROKEN to test rollback
    throw new Error('Simulated migration failure for testing rollback');
};

export const down = async (db, client) => {
    console.log('Rolling back broken migration (nothing to do)');
};
