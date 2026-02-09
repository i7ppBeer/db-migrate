/**
 * MongoDB DCL Test Config - Success Cases
 * 
 * DCL uses Repeatable mode for user/role management
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'admin',  // DCL operates on admin db
  },
  migrationsDir: './migrations',
  checksumCollection: '_dcl_migrations',
  mode: 'repeatable',
  idempotencyCheck: {
    enabled: true
  }
};
