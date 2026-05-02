// @description: Maintenance - collection cleanup with explicit allowance
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL
//
// Demonstrates @allow-dangerous annotation for controlled collection maintenance.
// All potentially dangerous ops are self-contained (no orphan drops).

export async function up(db, client) {
  // Create scratch collection, then drop it (not an orphan drop)
  await db.createCollection('_maintenance_scratch').catch(() => {});
  try {
    await db.collection('_maintenance_scratch').drop();
  } catch (e) {
    if (e.code !== 26) throw e; // 26 = NamespaceNotFound, safe to ignore
  }

  // Ensure maintenance log collection exists, then clean up old entries
  await db.createCollection('_maintenance_log').catch(() => {});
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
  await db.collection('_maintenance_log').deleteMany({ createdAt: { $lt: cutoff } });
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
