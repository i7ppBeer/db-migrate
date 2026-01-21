/**
 * MongoDB DCL Test Config - Failure Cases
 */
export default {
  type: 'mongodb',
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    database: process.env.MONGODB_DB || 'admin'
  },
  migrationsDir: './migrations',
  checksumCollection: '_dcl_migrations',
  mode: 'repeatable',
  idempotencyCheck: {
    enabled: true
  }
};
