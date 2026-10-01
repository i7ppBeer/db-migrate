/**
 * MongoDB Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mongodb',
  // Test fixture: its database is created from scratch on each run
  createDatabaseIfMissing: true,
  mongodb: {
    url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'test_mongo_failure',
  },
  // Each migration here declares how it must be rejected (-- @expect-error: CODE)
  // — test-all checks exactly that, per file. See src/core/fixture-expectations.js.
};
