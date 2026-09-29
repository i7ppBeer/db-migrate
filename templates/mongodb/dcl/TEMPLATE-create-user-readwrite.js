// Rename to R__011_readwrite_users.js before use.
//
// @allow-forbidden: true
// (updateUser in the "already exists" branch below is high-risk by default —
// static validation can't see which branch actually runs, so it applies to
// the whole file either way.)

export async function up(db, client) {
  const adminDb = client.db('admin');
  const username = 'app_readwrite';

  const existing = await adminDb.command({ usersInfo: username });
  if (existing.users.length === 0) {
    await adminDb.command({
      createUser: username,
      pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
      roles: [{ role: 'readWrite', db: 'myapp' }]
    });
    return { passwordSet: true, createdUsernames: [username], allUsernames: [username] };
  }

  await adminDb.command({ updateUser: username, roles: [{ role: 'readWrite', db: 'myapp' }] });
  return { passwordSet: false, allUsernames: [username] };
}
