// @allow-forbidden: true
/**
 * R__20260320_drop_user_shop_ddl.js
 * DCL High-Risk: dropUser — shop_ddl
 * ⚠️  dropUser is irreversible — approved via @allow-forbidden
 */

export async function up(db) {
  // ============================================
  // Drop: shop_ddl
  // ============================================
  const info = await db.command({ usersInfo: 'shop_ddl' });
  if (!info.users || info.users.length > 0) {
    await db.command({ dropUser: 'shop_ddl' });
    console.log('[DCL] Dropped user: shop_ddl');
  } else {
    console.log('[DCL] User shop_ddl does not exist, skipping drop');
  }
}

// DCL repeatable migrations do not support rollback
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
