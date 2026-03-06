export default {
  type: 'mariadb',

  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306', 10),
  user: process.env.MARIADB_USER || 'root',
  password: process.env.MARIADB_PASSWORD || 'rootpass',
  database: 'mysql',

  migrationsDir: './migrations',
  checksumTable: 'dcl_repeatable_migrations',
  mode: 'repeatable',
  idempotencyCheck: { enabled: true, verbose: true },
};
