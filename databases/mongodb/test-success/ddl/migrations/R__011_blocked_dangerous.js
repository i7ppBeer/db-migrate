// @description: Test dangerous operations without allow annotation
// @type: maintenance
//
// This file should be BLOCKED by validation because it contains
// dangerous operations without the @allow-dangerous annotation.

export async function up(db, client) {
  // This drop should be blocked without annotation
  await db.collection('important_data').drop();
  
  // This deleteMany({}) should also be blocked
  await db.collection('users').deleteMany({});
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
