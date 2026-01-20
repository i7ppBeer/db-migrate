/**
 * FAILURE CASE: Orphan drop in down()
 * 
 * This migration fails because:
 * 1. up() doesn't create 'legacy_data' collection
 * 2. down() tries to drop a collection not created by up()
 * 3. This could destroy existing production data!
 * 
 * Expected Error: "Orphan drop detected: down() drops collection not created in up()"
 */

export async function up(db, client) {
  // Create a new collection
  await db.createCollection('new_data');
  
  // Insert some data
  await db.collection('new_data').insertMany([
    { type: 'config', value: 'test' }
  ]);
}

export async function down(db, client) {
  // BUG: This drops the wrong collection!
  // Developer made a typo or copy-paste error
  // This could destroy production data that existed before this migration
  await db.collection('legacy_data').drop();  // WRONG COLLECTION!
  
  // The correct rollback would be:
  // await db.collection('new_data').drop();
}
