// @description: Dangerous operations example - data cleanup
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL
//
// This migration demonstrates using @allow-dangerous annotation
// to permit dangerous operations in MongoDB.

export async function up(db, client) {
  console.log('[DCL] Running dangerous cleanup with annotation...');
  
  // Create a temporary collection first (so drop is not orphan)
  await db.createCollection('temp_processing').catch(() => {});
  
  // Drop the temporary collection (dangerous but allowed)
  try {
    await db.collection('temp_processing').drop();
    console.log('[DCL] Dropped temp_processing collection');
  } catch (error) {
    if (error.code !== 26) { // 26 = NamespaceNotFound
      throw error;
    }
    console.log('[DCL] temp_processing collection does not exist, skipping');
  }
  
  // Ensure audit_logs collection exists
  await db.createCollection('audit_logs').catch(() => {});
  
  // Delete documents from audit collection older than 90 days (this is safe with condition)
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  
  const deleteResult = await db.collection('audit_logs').deleteMany({
    createdAt: { $lt: ninetyDaysAgo }
  });
  
  console.log(`[DCL] Deleted ${deleteResult.deletedCount} old audit logs`);
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
