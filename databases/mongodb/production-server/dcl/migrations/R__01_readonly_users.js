/**
 * R__01_readonly_users.js
 * DCL Repeatable Migration: Read-Only Users
 * 
 * This script is idempotent - safe to run multiple times
 * Will be re-executed when checksum changes
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
 */
async function createOrUpdateUser(adminDb, userSpec) {
  try {
    // Try to update existing user
    await adminDb.command({
      updateUser: userSpec.user,
      pwd: userSpec.pwd,
      roles: userSpec.roles
    });
  } catch (error) {
    if (error.codeName === 'UserNotFound') {
      // User doesn't exist, create it
      await adminDb.command({
        createUser: userSpec.user,
        pwd: userSpec.pwd,
        roles: userSpec.roles
      });
    } else {
      throw error;
    }
  }
}

// No down migration for repeatable DCL
