// @allow-forbidden: true
/**
 * R__02_shop_ddl_admin.js
 * DCL Repeatable Migration: Shop DDL Admin
 *
 * Idempotent: check user existence before create/update
 * Re-executed when checksum changes
 *
 * Note: @allow-forbidden is required because updateUser (role update) is
 * classified as a high-risk operation by the validator.
 */

async function upsertUser(db, username, roles) {
  const info = await db.command({ usersInfo: username });
  if (!info.users || info.users.length === 0) {
    await db.command({ createUser: username, pwd: 'CHANGE_ME_ON_FIRST_LOGIN', roles });
    console.log(`[DCL] Created user: ${username}`);
  } else {
    await db.command({ updateUser: username, roles });
    console.log(`[DCL] Updated user: ${username}`);
  }
}

export async function up(db) {
  // shop_ddl — full ownership of ecommerce database
  await upsertUser(db, 'shop_ddl', [{ role: 'dbOwner', db: 'ecommerce' }]);
}

// DCL repeatable migrations do not support rollback
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
