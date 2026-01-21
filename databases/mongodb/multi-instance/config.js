/**
 * MongoDB Multi-Instance Test Config
 * 
 * Test running same migrations across multiple database instances
 */
export default {
  type: 'mongodb',
  
  // Shared migrations for all instances
  migrationsDir: './migrations',
  changelogCollection: '_migrations',
  
  // Multiple database instances
  instances: [
    {
      name: 'primary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'test_multi_primary'
      }
    },
    {
      name: 'secondary-db',
      mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        database: 'test_multi_secondary'
      }
    }
  ]
};
