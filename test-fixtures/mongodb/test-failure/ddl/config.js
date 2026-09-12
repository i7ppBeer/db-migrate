/**
 * MongoDB Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'test_mongo_failure',
  },
  // test-all only: this fixture's migrations are intentionally dangerous/broken —
  // validate and up-down-up are expected to fail, and that counts as a pass.
  expectFailure: true,
};
