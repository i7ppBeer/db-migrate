#!/usr/bin/env node
/**
 * Database Connection Checker
 * Used by entrypoint.sh to verify database connectivity
 */

const DB_TYPE = process.env.DB_TYPE || 'mongodb';
const DB_HOST = process.env.DB_HOST ||
  (DB_TYPE === 'mariadb' ? (process.env.MARIADB_HOST || 'localhost') : (process.env.MONGODB_HOST || 'localhost'));
const DB_PORT = process.env.DB_PORT ||
  (DB_TYPE === 'mariadb' ? (process.env.MARIADB_PORT || '3306') : (process.env.MONGODB_PORT || '27017'));
const DB_USER = process.env.DB_USER || (DB_TYPE === 'mariadb' ? (process.env.MARIADB_USER || '') : '');
const DB_PASSWORD = process.env.DB_PASSWORD || (DB_TYPE === 'mariadb' ? (process.env.MARIADB_PASSWORD || '') : '');

async function checkMongoDB() {
  const { MongoClient } = await import('mongodb');
  
  let url = `mongodb://${DB_HOST}:${DB_PORT}`;
  if (DB_USER && DB_PASSWORD) {
    url = `mongodb://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}`;
  }
  
  const client = new MongoClient(url, { 
    serverSelectionTimeoutMS: 2000,
    connectTimeoutMS: 2000
  });
  
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    await client.close();
    process.exit(0);
  } catch (e) {
    console.error(`MongoDB connection check failed: ${e.message}`);
    process.exit(1);
  }
}

async function checkMariaDB() {
  const mysql = await import('mysql2/promise');
  
  try {
    const connection = await mysql.createConnection({
      host: DB_HOST,
      port: parseInt(DB_PORT),
      user: DB_USER || 'root',
      password: DB_PASSWORD,
      connectTimeout: 2000
    });
    await connection.ping();
    await connection.end();
    process.exit(0);
  } catch (e) {
    console.error(`MariaDB connection check failed: ${e.message}`);
    process.exit(1);
  }
}

if (DB_TYPE === 'mongodb') {
  await checkMongoDB();
} else {
  await checkMariaDB();
}
