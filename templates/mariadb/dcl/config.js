// DCL config — mode: 'repeatable' is required, without it these files'
// CREATE USER/GRANT statements are validated under DDL rules and need
// --allow-forbidden instead of just being what DCL files are for.
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: process.env.MARIADB_DB || 'myapp',
  checksumTable: '_dcl_migrations'
};
