/**
 * MongoDB Test Sample Config - Success Cases
 */
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGODB_DB || 'test_mongo_success' },
};
