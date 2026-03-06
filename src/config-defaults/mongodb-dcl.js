export default {
  type: 'mongodb',

  mongodb: {
    url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: 'admin',
  },

  migrationsDir: './migrations',
  checksumCollection: 'dcl_repeatable_migrations',
  mode: 'repeatable',
  idempotencyCheck: { enabled: true, verbose: true },
};
