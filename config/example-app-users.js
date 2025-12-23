/**
 * Migration Configuration for Users Database
 * 
 * Usage:
 *   node src/cli.js --config config/example-app-users.js up
 *   node src/cli.js --config config/example-app-users.js status
 */

const config = {
  mongodb: {
    // MongoDB connection URL
    url: process.env.USERS_DB_URL || "mongodb://localhost:27017",
    
    // Database name for users service
    databaseName: process.env.USERS_DB_NAME || "app_users",
    
    options: {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    }
  },

  // Migrations directory for users database
  migrationsDir: "migrations/users",

  // Collection to track applied migrations
  changelogCollectionName: "changelog",

  // Lock collection to prevent concurrent migrations
  lockCollectionName: "changelog_lock",
  
  // Lock TTL in seconds
  lockTtl: 300,

  // Migration file extension
  migrationFileExtension: ".js",

  // Enable file hash tracking
  useFileHash: true,

  // Module system
  moduleSystem: 'esm',
};

export default config;
