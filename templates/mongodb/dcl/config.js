// DCL config — mode: 'repeatable' is required. databaseName is typically
// 'admin' for DCL since createUser/updateUser/dropUser are admin-db commands
// even when the user's roles target a different database.
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },
  checksumCollection: '_dcl_migrations'
};
