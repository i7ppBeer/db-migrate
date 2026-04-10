// @allow-forbidden: true
/**
 * Repeatable Migration: Create application user
 * Must be idempotent - safe to run multiple times
 */

export async function up(db) {
  const username = 'app_user';
  const roles = [{ role: 'readWrite', db: 'test_mongo_success' }];

  const result = await db.command({ usersInfo: username });
  if (result.users.length > 0) {
    // User exists, update roles only
    await db.command({ updateUser: username, roles });
    console.log('[DCL] Updated app_user roles');
  } else {
    // User not exists, create with pwd + roles
    await db.command({ createUser: username, pwd: 'app_password', roles });
    console.log('[DCL] Created app_user');
  }
}

// DCL repeatable migrations don't need down
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
