// Rename to <timestamp>-add-phone-to-users.js before use.

export async function up(db, client) {
  await db.collection('users').updateMany(
    { phone: { $exists: false } },
    { $set: { phone: null } }
  );
}

export async function down(db, client) {
  await db.collection('users').updateMany({}, { $unset: { phone: '' } });
}
