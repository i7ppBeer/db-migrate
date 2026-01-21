/**
 * MongoDB Production Server - DCL Configuration
 * 
 * DCL (Data Control Language) migrations use Repeatable mode:
 * - Files prefixed with R__ are re-executed when checksum changes
 * - Must be idempotent (same result on multiple executions)
 * - No down migration required
 * 
 * Managed by: Platform Team
 */

export default {
  mongodb: {
    url: process.env.MONGODB_URL || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DATABASE || 'admin', // DCL operates on admin database
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  
  // DCL migrations directory (Repeatable mode)
  migrationsDir: './migrations',
  
  // Collection for tracking repeatable migrations
  checksumCollection: 'dcl_repeatable_migrations',
  
  // Migration mode: 'repeatable' for DCL
  mode: 'repeatable',
  
  // Idempotency verification enabled
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
