/**
 * MongoDB Test Sample Config - Failure Cases
 * These migrations contain intentional issues to test validation
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGO_URL || 'mongodb://localhost:27017',
    databaseName: process.env.MONGO_DB || 'test_mongo_failure'
  },
  migrationsDir: './migrations',
  changelogCollection: 'changelog'
};
