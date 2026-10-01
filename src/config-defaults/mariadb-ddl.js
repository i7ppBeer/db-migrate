export default {
  type: 'mariadb',

  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306', 10),
  // No fallback credentials — connect() refuses to run without them, so a
  // missing env var can't silently fall back to root / a well-known password.
  user: process.env.MARIADB_USER,
  password: process.env.MARIADB_PASSWORD,
  database: '',
  // A missing database is an error unless this is set (see connect())
  createDatabaseIfMissing: false,

  migrationsDir: './migrations',
  changelogTable: 'schema_migrations',
  mode: 'versioned',
  sanityCheck: { enabled: true, autoRollback: true, timeoutMs: 30000, verbose: true },

  // Bounds how long a migration's SQL may wait on MariaDB's metadata lock (MDL)
  // queue before giving up, instead of queuing indefinitely and blocking every
  // later query on the same table (see docs/LOCK-GUARD.md).
  ddlSafety: {
    lockGuard: {
      enabled: true,
      lockWaitTimeoutSec: 5,
      innodbLockWaitTimeoutSec: 5,
      maxRetries: 3,
      retryDelayMs: 2000
    }
  }
};
