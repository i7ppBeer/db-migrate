// @allow-forbidden: true
/**
 * Repeatable Migration: Create application user
 * Must be idempotent - safe to run multiple times
 */

export async function up(db) {
  const adminDb = db.admin();
  
  try {
    // Check if user exists
    const users = await db.command({ usersInfo: 'app_user' });
    
    if (users.users.length === 0) {
      // Create user if not exists
      await db.command({
        createUser: 'app_user',
        pwd: 'app_password',
        roles: [
          { role: 'readWrite', db: 'test_mongo_success' }
        ]
      });
      console.log('[DCL] Created app_user');
    } else {
      // Update roles if user exists (idempotent)
      await db.command({
        updateUser: 'app_user',
        roles: [
          { role: 'readWrite', db: 'test_mongo_success' }
        ]
      });
      console.log('[DCL] Updated app_user roles');
    }
  } catch (error) {
    // User might not exist, create it
    if (error.code === 11) {
      await db.command({
        createUser: 'app_user',
        pwd: 'app_password',
        roles: [
          { role: 'readWrite', db: 'test_mongo_success' }
        ]
      });
      console.log('[DCL] Created app_user (after check)');
    } else {
      throw error;
    }
  }
}

// DCL repeatable migrations don't need down
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
