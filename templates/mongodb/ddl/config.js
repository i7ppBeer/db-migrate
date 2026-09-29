// DDL config — only fields that differ from src/config-defaults/mongodb-ddl.js
// need to be here.
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGODB_DB || 'myapp' }
};
