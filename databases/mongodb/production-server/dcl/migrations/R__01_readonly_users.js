// @allow-forbidden: true
/**
 * R__01_readonly_users.js
 * DCL Repeatable Migration: Read-Only Users
 * 
 * This script is idempotent - safe to run multiple times
 * Will be re-executed when checksum changes
 * updateUser is used for roles-only update (no password change)
 */

export async function up(db, client, { createOrUpdateUser } = {}) {
  const adminDb = client.db('admin');
  
  // ============================================
  // Read-Only User for ecommerce database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'ecommerce_readonly',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'read', db: 'ecommerce' }
    ]
  });

  // ============================================
  // Read-Only User for analytics database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'analytics_readonly',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'read', db: 'analytics' }
    ]
  });

  // ============================================
  // Read-Only User for logging database
  // ============================================
  await createOrUpdateUser(adminDb, {
    user: 'logging_readonly',
    pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
    roles: [
      { role: 'read', db: 'logging' }
    ]
  });

  console.log('   ✅ Read-only users created/updated');
}

// No down migration for repeatable DCL
