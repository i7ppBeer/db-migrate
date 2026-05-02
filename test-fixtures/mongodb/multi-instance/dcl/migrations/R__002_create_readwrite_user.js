// @allow-forbidden: true
/**
 * DCL: Create application read-write user
 * Repeatable migration - re-applied when checksum changes
 * Must be idempotent (safe to run multiple times)
 * updateUser is used for roles-only update (no password change)
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  const username = 'app_readwrite';
  const roles = [
    { role: 'readWrite', db: 'test_multi_primary' },
    { role: 'readWrite', db: 'test_multi_secondary' }
  ];

  const result = await adminDb.command({ usersInfo: username });
  if (result.users.length > 0) {
    // User exists, update roles only
    await adminDb.command({ updateUser: username, roles });
    console.log('[DCL] Updated app_readwrite roles');
  } else {
    // User not exists, create with pwd + roles
    await adminDb.command({ createUser: username, pwd: 'readwrite_pass', roles });
    console.log('[DCL] Created app_readwrite user');
  }
}
