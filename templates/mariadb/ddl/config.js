// DDL config — only fields that differ from src/config-defaults/mariadb-ddl.js
// need to be here. Copy this file alongside the *.sql templates in this
// directory into your own project (e.g. test-fixtures/mariadb/my-project/ddl/).
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
