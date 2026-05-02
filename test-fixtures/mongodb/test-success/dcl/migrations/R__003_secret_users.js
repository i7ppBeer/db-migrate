// @allow-forbidden: true
/**
 * DCL Repeatable Migration: Secret service accounts (auto-generated passwords)
 * CHANGE_ME_ON_FIRST_LOGIN will be replaced at runtime with a secure password.
 * Each account receives its own unique password (one per CHANGE_ME occurrence).
 * Credentials are saved to /tmp/secret on first creation only.
 */
export async function up(db, client) {
  const adminDb = client.db('admin');

  const users = [
    {
      username: 'mongo_readonly_svc',
      password: 'CHANGE_ME_ON_FIRST_LOGIN',
      roles: [{ role: 'read', db: 'test_mongo_success' }]
    },
    {
      username: 'mongo_readwrite_svc',
      password: 'CHANGE_ME_ON_FIRST_LOGIN',
      roles: [{ role: 'readWrite', db: 'test_mongo_success' }]
    }
  ];

  let anyCreated = false;
  const createdUsernames = [];

  for (const u of users) {
    const existing = await adminDb.command({ usersInfo: u.username });

    if (existing.users.length === 0) {
      await adminDb.command({ createUser: u.username, pwd: u.password, roles: u.roles });
      console.log(`[DCL] Created ${u.username}`);
      anyCreated = true;
      createdUsernames.push(u.username);
    } else {
      await adminDb.command({ updateUser: u.username, roles: u.roles });
      console.log(`[DCL] Updated ${u.username} roles`);
    }
  }

  // passwordSet: true  → at least one new account created → write /tmp/secret + inject customData
  // passwordSet: false → all existed → skip
  // createdUsernames   → explicit list so runner doesn't need to regex-parse
  // allUsernames       → full list used for warning log when accounts already existed
  const allUsernames = users.map(u => u.username);
  return { passwordSet: anyCreated, createdUsernames, allUsernames };
}

