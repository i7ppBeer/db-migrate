export default {
  type: 'mariadb',

  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306', 10),
  user: process.env.MARIADB_USER || 'root',
  password: process.env.MARIADB_PASSWORD || 'rootpass',
  database: '',

  migrationsDir: './migrations',
  changelogTable: 'schema_migrations',
  mode: 'versioned',
  sanityCheck: { enabled: true, autoRollback: true, timeoutMs: 30000, verbose: true },
};
