export default {
  mongodb: {
    url: process.env.MONGODB_URL || "mongodb://localhost:27017",
    databaseName: process.env.USERS_DB_NAME || "users_db"
  },
  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  migrationFileExtension: ".js",
  useFileHash: false,
  validation: {
    forbidden: {
      database: [
        'dropDatabase',
        'createUser',
        'dropUser',
        'updateUser',
        'grantRolesToUser',
        'revokeRolesFromUser',
        'createRole',
        'dropRole',
        'updateRole',
        'repairDatabase',
        'cloneDatabase',
        'copyDatabase',
      ],
      collections: [
        'drop',
        'reIndex',
      ],
      system: [
        'shutdown',
        'killOp',
        'killAllSessions',
        'serverStatus',
        'replSetGetStatus',
        'isMaster',
      ],
      admin: [
        'enableSharding',
        'shardCollection',
        'movePrimary',
        'removeShard',
      ],
    }
  }
};
