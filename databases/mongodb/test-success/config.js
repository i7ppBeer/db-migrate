/**
 * MongoDB Test Sample Config - Success Cases
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGO_URL || 'mongodb://localhost:27017',
    databaseName: process.env.MONGO_DB || 'test_mongo_success',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  migrationsDir: './migrations',
  changelogCollectionName: 'changelog'
};
