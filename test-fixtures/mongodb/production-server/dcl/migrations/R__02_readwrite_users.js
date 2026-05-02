// @allow-forbidden: true
/**
 * R__02_readwrite_users.js
 * DCL Repeatable Migration: Read-Write Users (Application Service Accounts)
 * 
 * This script is idempotent - safe to run multiple times
 * Will be re-executed when checksum changes
 * updateUser is used for roles-only update (no password change)
 */

export async function up(db, client, { createOrUpdateUser } = {}) {
  const adminDb = client.db('admin');
  
  // ============================================
  // Application User for ecommerce database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'ecommerce_app',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'readWrite', db: 'ecommerce' }
    ]
  });

  // ============================================
  // Application User for analytics database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'analytics_app',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'readWrite', db: 'analytics' }
    ]
  });

  // ============================================
  // Application User for logging database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'logging_app',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'readWrite', db: 'logging' },
      // Logging app might need to read from other DBs for correlation
      { role: 'read', db: 'ecommerce' },
      { role: 'read', db: 'analytics' },
      { role: 'read', db: 'reporting' }
    ]
  });

  console.log('   ✅ Read-write users created/updated');
}

// No down migration for repeatable DCL
