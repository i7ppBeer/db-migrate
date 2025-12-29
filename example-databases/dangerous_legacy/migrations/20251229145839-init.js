export const up = async (db, client) => {
  // Create a collection to be dropped later
  await db.createCollection('users');
  await db.collection('users').insertOne({ name: 'Legacy User', role: 'admin' });
  
  // Create logs collection
  await db.collection('logs').createIndex({ createdAt: 1 });
};

export const down = async (db, client) => {
  await db.collection('logs').dropIndex('createdAt_1');
  await db.collection('users').drop();
};
