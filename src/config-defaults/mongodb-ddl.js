export default {
  type: 'mongodb',

  mongodb: {
    url: process.env.MONGODB_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: '',
  },

  migrationsDir: './migrations',
  changelogCollection: 'changelog',
  sanityCheck: { enabled: true, autoRollback: true, timeoutMs: 30000, verbose: true },
};
