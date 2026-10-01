#!/usr/bin/env node
/**
 * Database Connection Checker
 * Used by entrypoint.sh to wait until the database is reachable before a
 * command runs. Exit 0 = reachable, 1 = not (yet).
 *
 *   node src/check-db.js <config.js>   — preferred: the same type, host, port
 *                                        and credentials the command itself
 *                                        will use (every instance, for a
 *                                        multi-instance config)
 *   node src/check-db.js               — legacy: DB_TYPE/DB_HOST/… env vars
 *
 * Only checks that the server answers — not that the database exists (that's
 * connect()'s job, with a clearer error).
 */

const configPath = process.argv[2];

async function checkMariaDB({ host, port, user, password }) {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: host || 'localhost',
    port: parseInt(port || '3306', 10),
    user: user || undefined,
    password: password ?? undefined,
    connectTimeout: 2000
  });
  try {
    await connection.ping();
  } finally {
    await connection.end().catch(() => {});
  }
}

async function checkMongoDB({ url }) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Connection targets from a config file — one per instance. */
async function targetsFromConfig(path) {
  const { loadConfig } = await import('./adapters/index.js');
  const config = await loadConfig(path);
  const type = (config.type || '').toLowerCase();
  const entries = Array.isArray(config.instances) && config.instances.length > 0
    ? config.instances.map(i => ({ ...config, ...i }))
    : [config];
  return entries.map(c => {
    if (type === 'mongodb') {
      return { type, label: c.name || 'mongodb', params: { url: (c.mongodb || config.mongodb || {}).url || 'mongodb://localhost:27017' } };
    }
    const m = c.mariadb || c;
    return {
      type: 'mariadb',
      label: c.name || `${m.host || 'localhost'}:${m.port || 3306}`,
      params: { host: m.host, port: m.port, user: m.user ?? c.user, password: m.password ?? c.password }
    };
  });
}

/** Legacy env-var target (no config path given). */
function targetFromEnv() {
  const type = process.env.DB_TYPE || 'mongodb';
  const host = process.env.DB_HOST ||
    (type === 'mariadb' ? (process.env.MARIADB_HOST || 'localhost') : (process.env.MONGODB_HOST || 'localhost'));
  const port = process.env.DB_PORT ||
    (type === 'mariadb' ? (process.env.MARIADB_PORT || '3306') : (process.env.MONGODB_PORT || '27017'));
  if (type === 'mariadb') {
    return {
      type, label: `${host}:${port}`,
      params: { host, port, user: process.env.DB_USER || process.env.MARIADB_USER, password: process.env.DB_PASSWORD || process.env.MARIADB_PASSWORD }
    };
  }
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const auth = user && password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
  return { type, label: `${host}:${port}`, params: { url: `mongodb://${auth}${host}:${port}` } };
}

try {
  const targets = configPath ? await targetsFromConfig(configPath) : [targetFromEnv()];
  for (const t of targets) {
    try {
      await (t.type === 'mongodb' ? checkMongoDB(t.params) : checkMariaDB(t.params));
    } catch (e) {
      console.error(`${t.type} ${t.label}: ${e.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
} catch (e) {
  console.error(`Could not read config ${configPath}: ${e.message}`);
  process.exit(1);
}
