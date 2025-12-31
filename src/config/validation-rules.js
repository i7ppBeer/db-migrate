/**
 * MQL Validation Rules Configuration
 * Define what operations are allowed/forbidden in migrations
 */

export const validationRules = {
  // Allowed operations
  allowed: {
    // Collection operations
    collections: [
      'createCollection',
      'renameCollection',
      'createIndex',
      'createIndexes',
      'dropIndex',
      'dropIndexes',
    ],
    
    // Document operations (CRUD)
    documents: [
      'insertOne',
      'insertMany',
      'updateOne',
      'updateMany',
      'replaceOne',
      'deleteOne',
      'deleteMany',
      'findOneAndUpdate',
      'findOneAndReplace',
      'findOneAndDelete',
      'bulkWrite',
    ],
    
    // Index types
    indexTypes: [
      'unique',
      'sparse',
      'ttl',
      'text',
      'geo',
      'hashed',
      'wildcard',
    ],
    
    // Aggregation operations (for data migration)
    aggregation: [
      '$match',
      '$project',
      '$group',
      '$sort',
      '$limit',
      '$skip',
      '$unwind',
      '$lookup',
      '$addFields',
      '$set',
      '$unset',
    ],
  },

  // Forbidden operations
  forbidden: {
    // Database-level operations
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
    
    // Dangerous collection operations
    collections: [
      'drop',
      'dropCollection',
      'reIndex',
    ],
    
    // System operations
    system: [
      'shutdown',
      'killOp',
      'killAllSessions',
      'serverStatus',
      'replSetGetStatus',
      'isMaster',
    ],
    
    // Admin commands
    admin: [
      'enableSharding',
      'shardCollection',
      'movePrimary',
      'removeShard',
    ],
  },

  // Descriptions for tooltips
  descriptions: {
    // Database
    dropDatabase: 'DATA LOSS: Deletes the entire database',
    createUser: 'SECURITY: User management should be handled by IaC/Admin',
    dropUser: 'SECURITY: User management should be handled by IaC/Admin',
    updateUser: 'SECURITY: User management should be handled by IaC/Admin',
    grantRolesToUser: 'SECURITY: Role management should be handled by IaC/Admin',
    revokeRolesFromUser: 'SECURITY: Role management should be handled by IaC/Admin',
    createRole: 'SECURITY: Role management should be handled by IaC/Admin',
    dropRole: 'SECURITY: Role management should be handled by IaC/Admin',
    updateRole: 'SECURITY: Role management should be handled by IaC/Admin',
    repairDatabase: 'BLOCKING: Global lock, high resource usage',
    cloneDatabase: 'DEPRECATED: Can be slow and impact performance',
    copyDatabase: 'DEPRECATED: Can be slow and impact performance',
    
    // Collections
    drop: 'DATA LOSS: Deletes the entire collection',
    dropCollection: 'DATA LOSS: Deletes the entire collection',
    reIndex: 'BLOCKING: Locks the collection, impacts availability',
    
    // System
    shutdown: 'AVAILABILITY: Stops the database server',
    killOp: 'STABILITY: Interrupts operations, can cause inconsistency',
    killAllSessions: 'AVAILABILITY: Disconnects all users',
    serverStatus: 'INFO: Unnecessary in migrations',
    replSetGetStatus: 'INFO: Unnecessary in migrations',
    isMaster: 'INFO: Unnecessary in migrations',
    
    // Admin
    enableSharding: 'INFRA: Cluster configuration change',
    shardCollection: 'INFRA: Cluster configuration change',
    movePrimary: 'INFRA: Heavy data movement',
    removeShard: 'INFRA: Destructive cluster change',
  },

  // Custom validation functions
  custom: [
    {
      name: 'requireIndexOptions',
      description: 'Ensure indexes have proper options (unique, ttl, etc.)',
      message: 'Remember to specify index options (unique, sparse, ttl) where appropriate.',
      check: (code) => {
        // This always passes - just a reminder
        return true;
      },
    },
  ],

  // Warnings (operations that are allowed but should be reviewed)
  warnings: {
    operations: [
      'deleteMany',  // Could delete large amounts of data
      'updateMany',  // Could affect large amounts of data
      'mapReduce',   // Heavy operation, prefer aggregation
      'renameCollection', // Could overwrite target collection
    ],
  },
};

export default validationRules;
