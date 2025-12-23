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
    ],
    
    // Dangerous collection operations
    collections: [],
    
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

  // Custom validation functions
  custom: [
    {
      name: 'noDropCollection',
      description: 'Prevent dropping collections',
      message: 'Dropping collections is not allowed. Please remove data manually if needed.',
      check: (code) => {
        // More precise pattern for .drop() method call (not dropIndex, etc)
        const dropPatterns = [
          /(?<!drop[A-Z])\.\s*drop\s*\(/,  // .drop( but not .dropIndex, .dropDatabase, etc
          /\.collection\s*\(\s*['"][^'"]*['"]\s*\)\s*\.drop\s*\(/,  // collection('name').drop(
        ];
        
        for (const pattern of dropPatterns) {
          if (pattern.test(code)) {
            return false;
          }
        }
        
        return true;
      },
    },
    
    {
      name: 'noUserManagement',
      description: 'Prevent user/role management operations',
      message: 'User/Role management operations are not allowed in migrations.',
      check: (code) => {
        const userPatterns = [
          /createUser/,
          /dropUser/,
          /updateUser/,
          /grantRolesToUser/,
          /revokeRolesFromUser/,
          /createRole/,
          /dropRole/,
        ];
        
        for (const pattern of userPatterns) {
          if (pattern.test(code)) {
            return false;
          }
        }
        
        return true;
      },
    },
    
    {
      name: 'noDatabaseDrop',
      description: 'Prevent dropping database',
      message: 'Dropping database is strictly forbidden.',
      check: (code) => {
        if (/dropDatabase/.test(code)) {
          return false;
        }
        
        return true;
      },
    },
    
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
      'drop()',      // Could delete entire collection
    ],
  },
};

export default validationRules;
