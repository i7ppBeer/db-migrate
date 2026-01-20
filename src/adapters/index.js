/**
 * Adapter Factory
 * Creates the appropriate database adapter based on config
 * Supports multiple database instances in a single config
 */

import { MongoDBAdapter } from './mongodb-adapter.js';
import { MariaDBAdapter } from './mariadb-adapter.js';

/**
 * Create adapter from config (single instance)
 * @param {Object} config - Database configuration
 * @returns {BaseAdapter}
 */
export function createAdapter(config) {
  // Determine database type from config
  const dbType = detectDatabaseType(config);
  
  switch (dbType) {
    case 'mongodb':
      return new MongoDBAdapter(config);
    case 'mariadb':
    case 'mysql':
      return new MariaDBAdapter(config);
    default:
      throw new Error(`Unsupported database type: ${dbType}`);
  }
}

/**
 * Create multiple adapters from config with instances array
 * @param {Object} config - Config with instances array
 * @returns {Array<{name: string, adapter: BaseAdapter}>}
 */
export function createAdapters(config) {
  const adapters = [];
  
  // Check if config has instances array
  if (config.instances && Array.isArray(config.instances)) {
    for (const instance of config.instances) {
      // Merge instance config with base config
      const instanceConfig = {
        ...config,
        ...instance,
        // Instance-specific overrides
        mongodb: instance.mongodb || config.mongodb,
        mariadb: instance.mariadb || config.mariadb,
      };
      delete instanceConfig.instances; // Remove instances from merged config
      
      const adapter = createAdapter(instanceConfig);
      adapters.push({
        name: instance.name || `${adapter.dbType}-${adapters.length + 1}`,
        adapter,
        config: instanceConfig
      });
    }
  } else {
    // Single instance config
    const adapter = createAdapter(config);
    adapters.push({
      name: config.name || adapter.dbType,
      adapter,
      config
    });
  }
  
  return adapters;
}

/**
 * Detect database type from config
 * @param {Object} config 
 * @returns {string}
 */
function detectDatabaseType(config) {
  // Explicit type declaration
  if (config.type) {
    return config.type.toLowerCase();
  }
  
  // Detect from URL
  if (config.mongodb?.url || config.url?.startsWith('mongodb')) {
    return 'mongodb';
  }
  
  // Detect from connection config
  if (config.host || config.user || config.database) {
    // If has mongodb-specific fields
    if (config.mongodb) {
      return 'mongodb';
    }
    // Default to mariadb for host/user/database pattern
    return 'mariadb';
  }
  
  throw new Error('Cannot detect database type from config');
}

/**
 * Load config from file path
 * @param {string} configPath 
 * @returns {Promise<Object>}
 */
export async function loadConfig(configPath) {
  try {
    const absolutePath = configPath.startsWith('/') 
      ? configPath 
      : `${process.cwd()}/${configPath}`;
    
    const configModule = await import(`file://${absolutePath}`);
    return configModule.default;
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
  }
}

export default { createAdapter, createAdapters, loadConfig };
