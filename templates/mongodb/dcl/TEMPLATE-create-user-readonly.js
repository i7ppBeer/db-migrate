// Rename to R__010_readonly_users.js (R__<seq>_<name>.js) before use, or:
//   node src/cli.js create-dcl readonly_users -n 010 -c <dcl-config>
//
// CHANGE_ME_ON_FIRST_LOGIN is replaced at runtime with an independently
// generated password — never written back to this file, never printed to
// the console. It shows up exactly once, in plaintext, in the run's
// notification email (reports/notification.html), labeled as a temporary
// credential that expires on first login. See docs/DCL-PASSWORD.md.
//
// passwordSet / createdUsernames / allUsernames in the return value are how
// the runner tells "new account" from "already existed" from "password
// rotated" apart — see repeatable-runner.js's runMongoDB() for the exact
// contract, or TEMPLATE-rotate-password.js for the third case.
//
// @allow-forbidden: true
// (updateUser in the "already exists" branch below is high-risk by default —
// static validation can't see which branch actually runs, so it applies to
// the whole file either way.)

export async function up(db, client) {
  const adminDb = client.db('admin');
  const username = 'app_readonly';

  const existing = await adminDb.command({ usersInfo: username });
  if (existing.users.length === 0) {
    await adminDb.command({
      createUser: username,
      pwd: 'CHANGE_ME_ON_FIRST_LOGIN',
      roles: [{ role: 'read', db: 'myapp' }]
    });
    return { passwordSet: true, createdUsernames: [username], allUsernames: [username] };
  }

  await adminDb.command({ updateUser: username, roles: [{ role: 'read', db: 'myapp' }] });
  return { passwordSet: false, allUsernames: [username] };
}
