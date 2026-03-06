/**
 * MongoDB DCL Test Config - Success Cases
 * 
 * DCL uses Repeatable mode for user/role management
 */
export default {
  type: 'mongodb',
  mode: 'repeatable',
  checksumCollection: '_dcl_migrations',
};
