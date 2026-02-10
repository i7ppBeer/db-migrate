/**
 * DCL: Create application read-write user
 * Repeatable migration - re-applied when checksum changes
 * Must be idempotent (safe to run multiple times)
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // Check if user exists, drop and recreate for idempotency
  try {
    await adminDb.command({
      usersInfo: { user: 'app_readwrite', db: 'admin' }
    }).then(result => {
      if (result.users.length > 0) {
        return adminDb.command({ dropUser: 'app_readwrite' });
      }
    });
  } catch (e) {
    // User doesn't exist, continue
  }
  
  // Create read-write user
  await adminDb.command({
    createUser: 'app_readwrite',
    pwd: 'readwrite_pass',
    roles: [
      { role: 'readWrite', db: 'test_multi_primary' },
      { role: 'readWrite', db: 'test_multi_secondary' }
    ]
  });
  
  console.log('[DCL] Created app_readwrite user');
}
