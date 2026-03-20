// @allow-forbidden: true
/**
 * R__20260320_drop_user_shop_report.js
 * DCL High-Risk: dropUser — shop_report
 * ⚠️  dropUser is irreversible — approved via @allow-forbidden
 */

export async function up(db) {
  // ============================================
  // Drop: shop_report
  // ============================================
  const info = await db.command({ usersInfo: 'shop_report' });
  if (!info.users || info.users.length > 0) {
    await db.command({ dropUser: 'shop_report' });
    console.log('[DCL] Dropped user: shop_report');
  } else {
    console.log('[DCL] User shop_report does not exist, skipping drop');
  }
}

// DCL repeatable migrations do not support rollback
export async function down(db) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
