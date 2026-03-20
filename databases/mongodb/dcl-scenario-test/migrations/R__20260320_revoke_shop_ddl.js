// @allow-forbidden: true
/**
 * R__20260320_revoke_shop_ddl.js
 * DCL High-Risk: revokeRolesFromUser — shop_ddl
 * ⚠️  Contains revokeRolesFromUser — approved via @allow-forbidden
 * ⚠️  Idempotent: uses usersInfo to check role existence before revoking
 */

export async function up(db) {
  // ============================================
  // Revoke: shop_ddl (dbOwner ON ecommerce)
  // ============================================
  const info = await db.command({ usersInfo: 'shop_ddl' });
  if (!info.users || info.users.length === 0) {
    console.log('[DCL] User shop_ddl does not exist, skipping revoke');
    return;
  }

  const user = info.users[0];
  const hasRole = (user.roles || []).some(
    r => r.role === 'dbOwner' && r.db === 'ecommerce'
  );

  if (hasRole) {
    await db.command({
      revokeRolesFromUser: 'shop_ddl',
      roles: [{ role: 'dbOwner', db: 'ecommerce' }]
    });
    console.log('[DCL] Revoked dbOwner on ecommerce from shop_ddl');
  } else {
    console.log('[DCL] shop_ddl does not have dbOwner on ecommerce, skipping revoke');
  }
}

// DCL repeatable migrations do not support rollback
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
