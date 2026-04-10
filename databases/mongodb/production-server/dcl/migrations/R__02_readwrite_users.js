// @allow-forbidden: true
/**
 * R__02_readwrite_users.js
 * DCL Repeatable Migration: Read-Write Users (Application Service Accounts)
 * 
 * This script is idempotent - safe to run multiple times
 * Will be re-executed when checksum changes
 * updateUser is used for roles-only update (no password change)
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // ============================================
  // Application User for ecommerce database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'ecommerce_app',
    pwd: 'ecommerce_app_secure_pass_123',
    roles: [
      { role: 'readWrite', db: 'ecommerce' }
    ]
  });

  // ============================================
  // Application User for analytics database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'analytics_app',
    pwd: 'analytics_app_secure_pass_456',
    roles: [
      { role: 'readWrite', db: 'analytics' }
    ]
  });

  // ============================================
  // Application User for logging database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'logging_app',
    pwd: 'logging_app_secure_pass_789',
    roles: [
      { role: 'readWrite', db: 'logging' },
      // Logging app might need to read from other DBs for correlation
      { role: 'read', db: 'ecommerce' },
      { role: 'read', db: 'analytics' }
    ]
  });

  console.log('   ✅ Read-write users created/updated');
}

/**
 * Helper: Create or update user (idempotent)
 * - User exists: update roles only (preserve password)
 * - User not exists: create with pwd + roles
 */
async function createOrUpdateUser(adminDb, userSpec) {
  const result = await adminDb.command({ usersInfo: userSpec.user });
  if (result.users.length > 0) {
    // User exists, update roles only
    await adminDb.command({
      updateUser: userSpec.user,
      roles: userSpec.roles
    });
  } else {
    // User not exists, create with pwd + roles
    await adminDb.command({
      createUser: userSpec.user,
      pwd: userSpec.pwd,
      roles: userSpec.roles
    });
  }
}

// No down migration for repeatable DCL
