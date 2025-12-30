export default {
  mongodb: {
    url: process.env.MONGODB_URL || "mongodb://localhost:27017",
    databaseName: process.env.DANGEROUS_DB_NAME || "legacy_prod_db"
  },
  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  migrationFileExtension: ".js",
  useFileHash: false,
  // Override validation rules for this specific database
  validation: {
    forbidden: {
      database: ['dropDatabase', 'createUser', 'dropUser', 'updateUser', 'grantRolesToUser', 'revokeRolesFromUser', 'createRole', 'dropRole', 'updateRole', 'repairDatabase', 'cloneDatabase', 'copyDatabase'],
      collections: ['drop', 'reIndex'],
      system: ['shutdown', 'killOp', 'killAllSessions', 'serverStatus', 'replSetGetStatus', 'isMaster'],
      admin: ['enableSharding', 'shardCollection', 'movePrimary', 'removeShard']
    }
  }};
