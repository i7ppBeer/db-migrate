/**
 * MongoDB Production Server - DDL Configuration (ecommerce database)
 * 
 * DDL (Data Definition Language) migrations use Versioned mode:
 * - Files prefixed with timestamp: 20260101000001-xxx.js
 * - Requires both up() and down() functions
 * - Executed once, tracked in changelog
 * 
 * Managed by: Development Team (ecommerce)
 */

export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URL || 'mongodb://ecommerce_app:ecommerce_app_secure_pass_123@localhost:27017',
    databaseName: process.env.MONGODB_DATABASE || 'ecommerce',
  },
};
