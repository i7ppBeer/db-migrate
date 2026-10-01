/**
 * MongoDB Sanity Check — real rollback fixture.
 * Its one migration's postCheck fails by design; with --sanity-check,
 * test-all checks it was rolled back and the database is as it was before.
 */
export default {
  type: 'mongodb',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  mongodb: { databaseName: process.env.MONGODB_DB || 'test_mongo_sanity_rollback' },
};
