/**
 * MongoDB Test Sample Config - Success Cases
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'test_mongo_success'
  },
  migrationsDir: './migrations',
  changelogCollection: 'changelog'
};
