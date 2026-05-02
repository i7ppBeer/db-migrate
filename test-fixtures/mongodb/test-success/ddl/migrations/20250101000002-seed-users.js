/**
 * Migration: Seed initial users
 * Type: DML (Data Manipulation Language)
 * 
 * This migration shows:
 * 1. Inserting seed data
 * 2. Using idempotent operations (upsert)
 * 3. Proper cleanup in down()
 */

const seedUsers = [
  {
    _id: 'seed-user-admin',
    email: 'admin@example.com',
    name: 'System Admin',
    status: 'active',
    role: 'admin',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    _id: 'seed-user-demo',
    email: 'demo@example.com',
    name: 'Demo User',
    status: 'active',
    role: 'user',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  },
  {
    _id: 'seed-user-test',
    email: 'test@example.com',
    name: 'Test User',
    status: 'pending',
    role: 'user',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z')
  }
];

export async function up(db, client) {
  const collection = db.collection('users');
  
  // Use bulkWrite with upsert for idempotency
  const operations = seedUsers.map(user => ({
    updateOne: {
      filter: { _id: user._id },
      update: { $setOnInsert: user },
      upsert: true
    }
  }));

  const result = await collection.bulkWrite(operations);
  
  console.log(`[MIGRATION] Seeded users: ${result.upsertedCount} inserted, ${result.matchedCount} already existed`);
}

export async function down(db, client) {
  const collection = db.collection('users');
  
  // Remove only the seeded users by their known IDs
  const seedIds = seedUsers.map(u => u._id);
  const result = await collection.deleteMany({ _id: { $in: seedIds } });
  
  console.log(`[MIGRATION] Removed ${result.deletedCount} seed users`);
}
