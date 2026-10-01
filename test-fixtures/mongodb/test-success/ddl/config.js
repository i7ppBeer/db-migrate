/**
 * MongoDB Test Sample Config - Success Cases
 */
export default {
  type: 'mongodb',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  mongodb: { databaseName: process.env.MONGODB_DB || 'test_mongo_success' },
};
