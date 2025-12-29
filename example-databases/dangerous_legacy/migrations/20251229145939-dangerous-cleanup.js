export const up = async (db, client) => {
  // DANGEROUS: Dropping a collection (users created in previous migration)
  try {
    await db.collection('users').drop();
  } catch (e) {
    // Ignore if already dropped
  }
  
  // DANGEROUS: Dropping the database
  // Note: In a real scenario, this would wipe everything including the changelog!
  // For testing purposes, we might want to skip actual db drop to allow status check to pass,
  // OR we accept that status check might fail after this.
  // Let's just drop a collection to simulate danger without destroying the migration tracking.
  
  // await db.dropDatabase(); // Commented out to keep migration history for test verification
  
  // Instead, let's do another dangerous op: remove all users with admin role
  // (Simulating a destructive data operation)
  // Since we dropped 'users' above, let's create it again just to delete from it? 
  // No, let's just stick to the collection drop as the dangerous op.
};

export const down = async (db, client) => {
  // Restore the users collection
  await db.createCollection('users');
  await db.collection('users').insertOne({ name: 'Legacy User', role: 'admin' });
};
