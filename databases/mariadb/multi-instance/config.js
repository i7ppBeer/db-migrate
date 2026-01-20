/**
 * Multi-Instance MariaDB Configuration Example
 * 
 * Use this config to test migrations on multiple MariaDB instances
 * (e.g., primary, replica, analytics databases)
 */
export default {
  type: 'mariadb',
  
  // Shared migrations directory
  migrationsDir: './migrations',
  
  // Multiple database instances
  instances: [
    {
      name: 'mariadb-primary',
      host: process.env.MARIADB_PRIMARY_HOST || 'localhost',
      port: parseInt(process.env.MARIADB_PRIMARY_PORT || '3306', 10),
      database: process.env.MARIADB_PRIMARY_DB || 'app_primary',
      user: process.env.MARIADB_USER || 'root',
      password: process.env.MARIADB_PASSWORD || 'rootpass',
      changelogTable: '_migrations'
    },
    {
      name: 'mariadb-replica',
      host: process.env.MARIADB_REPLICA_HOST || 'localhost',
      port: parseInt(process.env.MARIADB_REPLICA_PORT || '3306', 10),
      database: process.env.MARIADB_REPLICA_DB || 'app_replica',
      user: process.env.MARIADB_USER || 'root',
      password: process.env.MARIADB_PASSWORD || 'rootpass',
      changelogTable: '_migrations'
    },
    {
      name: 'mariadb-analytics',
      host: process.env.MARIADB_ANALYTICS_HOST || 'localhost',
      port: parseInt(process.env.MARIADB_ANALYTICS_PORT || '3306', 10),
      database: process.env.MARIADB_ANALYTICS_DB || 'app_analytics',
      user: process.env.MARIADB_USER || 'root',
      password: process.env.MARIADB_PASSWORD || 'rootpass',
      changelogTable: '_migrations'
    }
  ]
};
