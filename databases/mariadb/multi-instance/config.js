/**
 * MariaDB Multi-Instance Test Config
 * 
 * Test running same migrations across multiple database instances
 */
export default {
  type: 'mariadb',
  
  // Shared migrations for all instances
  migrationsDir: './migrations',
  changelogTable: '_migrations',
  
  // Multiple database instances
  instances: [
    {
      name: 'primary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'test_multi_primary',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass'
      }
    },
    {
      name: 'secondary-db',
      mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306', 10),
        database: 'test_multi_secondary',
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'rootpass'
      }
    }
  ]
};
