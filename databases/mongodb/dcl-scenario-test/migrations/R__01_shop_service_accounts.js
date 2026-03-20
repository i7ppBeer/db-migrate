// @allow-forbidden: true
/**
 * R__01_shop_service_accounts.js
 * DCL Repeatable Migration: Shop Service Accounts
 *
 * Idempotent: check user existence before create/update
 * Re-executed when checksum changes
 *
 * Note: @allow-forbidden is required because updateUser (role update) is
 * classified as a high-risk operation by the validator.
 */

// ============================================
// shop_api
// ============================================
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
  // shop_api — read/write on ecommerce
  await upsertUser(db, 'shop_api', [{ role: 'readWrite', db: 'ecommerce' }]);

  // shop_report — read-only on ecommerce
  await upsertUser(db, 'shop_report', [{ role: 'read', db: 'ecommerce' }]);
}

// DCL repeatable migrations do not support rollback
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
