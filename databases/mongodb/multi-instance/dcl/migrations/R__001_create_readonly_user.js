/**
 * DCL: Create application read-only user
 * Repeatable migration - re-applied when checksum changes
 * Must be idempotent (safe to run multiple times)
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // Check if user exists, drop and recreate for idempotency
  try {
    await adminDb.command({
      usersInfo: { user: 'app_readonly', db: 'admin' }
    }).then(result => {
      if (result.users.length > 0) {
        return adminDb.command({ dropUser: 'app_readonly' });
      }
    });
  } catch (e) {
    // User doesn't exist, continue
  }
  
  // Create read-only user
  await adminDb.command({
    createUser: 'app_readonly',
    pwd: 'readonly_pass',
    roles: [
      { role: 'read', db: 'test_multi_primary' },
      { role: 'read', db: 'test_multi_secondary' }
    ]
  });
  
  console.log('[DCL] Created app_readonly user');
}
