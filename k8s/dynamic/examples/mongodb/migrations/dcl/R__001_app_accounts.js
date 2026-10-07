// @allow-forbidden: true
/**
 * Repeatable: re-runs whenever this file changes, so it must be idempotent.
 * CHANGE_ME_ON_FIRST_LOGIN is replaced with a generated password, delivered
 * only in the run's DCL notification email (docs/DCL-PASSWORD.md).
 */
export async function up(db, client) {
  const adminDb = client.db('admin');
  const users = [
    { username: 'shop_app', password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [{ role: 'readWrite', db: 'shop' }] },
    { username: 'shop_readonly', password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [{ role: 'read', db: 'shop' }] },
  ];

  const createdUsernames = [];
  for (const u of users) {
    const existing = await adminDb.command({ usersInfo: u.username });
    if (existing.users.length === 0) {
      await adminDb.command({ createUser: u.username, pwd: u.password, roles: u.roles });
      createdUsernames.push(u.username);
    } else {
      await adminDb.command({ updateUser: u.username, roles: u.roles });
    }
  }
  return { passwordSet: createdUsernames.length > 0, createdUsernames, allUsernames: users.map(u => u.username) };
}
