/**
 * Adapter Factory
 * Creates the appropriate database adapter based on config
 * Supports multiple database instances in a single config
 */

import { isAbsolute } from 'path';
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
  // Explicit type declaration (highest priority)
  if (config.type) {
    return config.type.toLowerCase();
  }
  
  // Detect from mongodb-specific config
  if (config.mongodb) {
    return 'mongodb';
  }
  
  // Detect from URL
  if (config.url?.startsWith('mongodb')) {
    return 'mongodb';
  }
  
  // Detect from mariadb-specific config
  if (config.mariadb) {
    return 'mariadb';
  }
  
  // Detect from connection config (host/user/database pattern = relational DB)
  if (config.host || config.user || config.database) {
    return 'mariadb';
  }
  
  throw new Error('Cannot detect database type from config. Set "type" explicitly (e.g. type: "mongodb" or type: "mariadb").');
}

/**
 * Load config from file path.
 * If the exported config has a `type` field, the corresponding defaults
 * (src/config-defaults/<type>-<dcl|ddl>.js) are loaded and shallow-merged
 * with 1-level deep merge for nested objects, so config files only need to
 * export the values that differ from the defaults.
 *
 * @param {string} configPath
 * @returns {Promise<Object>}
 */
export async function loadConfig(configPath) {
  try {
    // isAbsolute() (not a leading-'/' check) so an already-absolute Windows
    // path (e.g. C:\...) isn't re-prefixed with cwd into a broken double path.
    const absolutePath = isAbsolute(configPath)
      ? configPath
      : `${process.cwd()}/${configPath}`;

    // Resolve to real path and validate it doesn't escape expected boundaries
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const resolvedPath = resolve(absolutePath);

    // Block null bytes (path traversal attack vector)
    if (resolvedPath.includes('\0')) {
      throw new Error('Config path contains invalid characters');
    }

    const configModule = await import(`file://${resolvedPath}`);
    const userConfig = configModule.default;

    // Merge with defaults when type is declared
    if (userConfig && userConfig.type) {
      const isRepeatable = userConfig.mode === 'repeatable';
      const dbType = userConfig.type.toLowerCase();
      const variant = isRepeatable ? 'dcl' : 'ddl';

      // Locate defaults file relative to this source file
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const defaultsPath = resolve(__dirname, `../config-defaults/${dbType}-${variant}.js`);

      let defaults = {};
      try {
        const defaultsModule = await import(`file://${defaultsPath}`);
        defaults = defaultsModule.default;
      } catch {
        // Unknown type/variant combination — skip merge
      }

      // Shallow merge: defaults first, user config overrides
      const merged = { ...defaults, ...userConfig };

      // 1-level deep merge for well-known nested objects
      const DEEP_MERGE_KEYS = ['mongodb', 'mariadb', 'sanityCheck', 'idempotencyCheck'];
      for (const key of DEEP_MERGE_KEYS) {
        if (defaults[key] || userConfig[key]) {
          merged[key] = { ...(defaults[key] || {}), ...(userConfig[key] || {}) };
        }
      }

      return merged;
    }

    return userConfig;
  } catch (error) {
    throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
  }
}

export default { createAdapter, createAdapters, loadConfig };
