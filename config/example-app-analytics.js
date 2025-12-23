/**
 * Migration Configuration for Analytics Database
 * 
 * Usage:
 *   node src/cli.js --config config/example-app-analytics.js up
 *   node src/cli.js --config config/example-app-analytics.js status
 */

const config = {
  mongodb: {
    // MongoDB connection URL (can be different cluster)
    url: process.env.ANALYTICS_DB_URL || "mongodb://localhost:27017",
    
    // Database name for analytics service
    databaseName: process.env.ANALYTICS_DB_NAME || "app_analytics",
    
    options: {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    }
  },

  // Migrations directory for analytics database
  migrationsDir: "migrations/analytics",

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
