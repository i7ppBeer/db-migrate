// MongoDB Migration Configuration
// This config can be overridden by environment variables in K8s
// For multi-database support, use --config flag to specify different config files

const config = {
  mongodb: {
    // MongoDB connection URL - override with MONGODB_URL env var
    url: process.env.MONGODB_URL || "mongodb://localhost:27017",
    
    // Database name - override with MONGODB_DATABASE env var
    databaseName: process.env.MONGODB_DATABASE || "myapp",
    
    options: {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
    }
  },

  // Migrations directory - override with MIGRATIONS_DIR env var
  migrationsDir: process.env.MIGRATIONS_DIR || "migrations",

  // Collection to track applied migrations
  changelogCollectionName: "changelog",

  // Lock collection to prevent concurrent migrations
  lockCollectionName: "changelog_lock",
  
  // Lock TTL in seconds (0 = disabled)
  lockTtl: 300,

  // Migration file extension
  migrationFileExtension: ".js",

  // Enable file hash tracking
  useFileHash: true,

  // Module system
  moduleSystem: 'esm',
};

export default config;
