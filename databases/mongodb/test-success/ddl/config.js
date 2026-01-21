/**
 * MongoDB Test Sample Config - Success Cases
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'test_mongo_success',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  migrationsDir: './migrations',
  changelogCollectionName: 'changelog'
};
