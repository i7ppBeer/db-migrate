/**
 * Multi-Instance MongoDB Configuration Example
 * 
 * Use this config to test migrations on multiple MongoDB instances
 * (e.g., primary, secondary, tertiary databases)
 */
export default {
  type: 'mongodb',
  
  // Shared migrations directory (all instances use the same migrations)
  migrationsDir: './migrations',
  
  // Multiple database instances
  instances: [
    {
      name: 'mongo-primary',
      mongodb: {
        url: process.env.MONGO_PRIMARY_URL || 'mongodb://localhost:27017',
        databaseName: process.env.MONGO_PRIMARY_DB || 'app_primary',
        options: {
          useNewUrlParser: true,
          useUnifiedTopology: true
        }
      },
      changelogCollectionName: 'changelog'
    },
    {
      name: 'mongo-secondary',
      mongodb: {
        url: process.env.MONGO_SECONDARY_URL || 'mongodb://localhost:27017',
        databaseName: process.env.MONGO_SECONDARY_DB || 'app_secondary',
        options: {
          useNewUrlParser: true,
          useUnifiedTopology: true
        }
      },
      changelogCollectionName: 'changelog'
    },
    {
      name: 'mongo-tertiary',
      mongodb: {
        url: process.env.MONGO_TERTIARY_URL || 'mongodb://localhost:27017',
        databaseName: process.env.MONGO_TERTIARY_DB || 'app_tertiary',
        options: {
          useNewUrlParser: true,
          useUnifiedTopology: true
        }
      },
      changelogCollectionName: 'changelog'
    }
  ]
};
