export default {
  type: 'mariadb',

  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306', 10),
  // No fallback credentials — connect() refuses to run without them, so a
  // missing env var can't silently fall back to root / a well-known password.
  user: process.env.MARIADB_USER,
  password: process.env.MARIADB_PASSWORD,
  database: 'mysql',

  migrationsDir: './migrations',
  checksumTable: 'dcl_repeatable_migrations',
  mode: 'repeatable',
  idempotencyCheck: { enabled: true, verbose: true },
};
