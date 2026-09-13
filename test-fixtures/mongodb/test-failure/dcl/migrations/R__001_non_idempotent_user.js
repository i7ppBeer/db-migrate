// @expect-fail: true
/**
 * Repeatable Migration: INVALID - Not idempotent
 * This should FAIL because createUser will error on second run
 */

export async function up(db) {
  // Non-idempotent: Will fail on second run
  await db.command({
    createUser: 'temp_user',
    pwd: 'temp_password',
    roles: [{ role: 'root', db: 'admin' }]
  });
  console.log('[DCL] Created temp_user');
}

export async function down(db) {
  // No down for repeatable
}
