/**
 * Migration Configuration for Orders Database
 * 
 * Usage:
 *   node src/cli.js --config config/example-app-orders.js up
 *   node src/cli.js --config config/example-app-orders.js status
 */

const config = {
  mongodb: {
    // MongoDB connection URL
    url: process.env.ORDERS_DB_URL || "mongodb://localhost:27017",
    
    // Database name for orders service
    databaseName: process.env.ORDERS_DB_NAME || "app_orders",
    
    options: {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    }
  },

  // Migrations directory for orders database
  migrationsDir: "migrations/orders",

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
