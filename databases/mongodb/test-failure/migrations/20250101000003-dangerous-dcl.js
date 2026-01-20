/**
 * FAILURE CASE: DCL operation without proper authorization
 * 
 * This migration will fail validation because:
 * 1. createUser is a DCL (Data Control Language) operation
 * 2. Should be handled separately from DDL/DML migrations
 * 
 * Expected Warning/Error: "DCL operation detected: createUser"
 */

export async function up(db, client) {
  // Creating collections is fine
  await db.createCollection('audit_log');

  // PROBLEM: User management should NOT be in migrations!
  // This is a security concern and deployment issue
  await db.command({
    createUser: 'app_user',
    pwd: 'insecure_password_123',  // Hardcoded password!
    roles: [
      { role: 'readWrite', db: 'myapp' }
    ]
  });
}

export async function down(db, client) {
  await db.collection('audit_log').drop();
  
  // Dropping users is also problematic
  await db.command({
    dropUser: 'app_user'
  });
}
