/**
 * FAILURE CASE: Dangerous operation - dropDatabase
 * 
 * This migration will fail validation because:
 * 1. dropDatabase() is a forbidden operation
 * 2. It affects ALL collections, not just migration-specific ones
 * 
 * Expected Error: "Dangerous operation detected: dropDatabase"
 */

export async function up(db, client) {
  // Some normal operation
  await db.createCollection('temp_collection');
}

export async function down(db, client) {
  // DANGER: This will destroy EVERYTHING!
  // This is a real-world mistake that happens when developers
  // don't understand the scope of their rollback
  await db.dropDatabase();
}
