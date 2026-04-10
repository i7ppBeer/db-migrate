// @allow-forbidden: true
/**
 * R__01_readonly_users.js
 * DCL Repeatable Migration: Read-Only Users
 * 
 * This script is idempotent - safe to run multiple times
 * Will be re-executed when checksum changes
 * updateUser is used for roles-only update (no password change)
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // ============================================
  // Read-Only User for ecommerce database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'ecommerce_readonly',
    pwd: 'readonly_secure_password_123',
    roles: [
      { role: 'read', db: 'ecommerce' }
    ]
  });

  // ============================================
  // Read-Only User for analytics database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'analytics_readonly',
    pwd: 'analytics_readonly_pass_456',
    roles: [
      { role: 'read', db: 'analytics' }
    ]
  });

  // ============================================
  // Read-Only User for logging database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'logging_readonly',
    pwd: 'logging_readonly_pass_789',
    roles: [
      { role: 'read', db: 'logging' }
    ]
  });

  console.log('   ✅ Read-only users created/updated');
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
