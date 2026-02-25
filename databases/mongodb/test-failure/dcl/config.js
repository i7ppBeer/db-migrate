/**
 * MongoDB DCL Test Config - Failure Cases
 */
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DATABASE || process.env.MONGODB_DB || 'admin'
  },
  migrationsDir: './migrations',
  checksumCollection: '_dcl_migrations',
  mode: 'repeatable',
  idempotencyCheck: {
    enabled: true
  }
};
