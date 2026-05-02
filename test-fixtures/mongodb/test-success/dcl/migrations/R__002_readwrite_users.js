/**
 * DCL Repeatable Migration: readwrite_users
 * File: R__002_readwrite_users.js
 * Created: 2026-01-21T08:55:22.359Z
 * 
 * ⚠️  IMPORTANT: This script must be IDEMPOTENT!
 * It will run whenever the checksum changes.
 * Always check existence before creating users/roles!
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // Example: Create user if not exists
  // try {
  //   const users = await adminDb.command({ usersInfo: 'app_readonly' });
  //   if (users.users.length === 0) {
  //     await adminDb.command({
  //       createUser: 'app_readonly',
  //       pwd: 'password',
  //       roles: [{ role: 'read', db: 'admin' }]
  //     });
  //     console.log('[DCL] Created app_readonly user');
  //   } else {
  //     // Update existing user's roles (idempotent)
  //     await adminDb.command({
  //       updateUser: 'app_readonly',
  //       roles: [{ role: 'read', db: 'admin' }]
  //     });
  //     console.log('[DCL] Updated app_readonly user roles');
  //   }
  // } catch (error) {
  //   console.error('[DCL] Error managing user:', error.message);
  //   throw error;
  // }
  
  // Your DCL statements here:
  
}

// Note: DCL migrations typically don't need down()
// Permission changes should be managed forward-only
export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
