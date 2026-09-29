// Rename to R__020_rotate_app_readonly_password.js before use.
//
// MongoDB has no ALTER-USER-style syntax the runner can sniff to tell "this
// is a forced rotation" apart from "this is a brand new account" the way
// the MariaDB adapter detects ALTER USER — so the migration has to say so
// explicitly: return passwordSet: 'rotated' (not `true`) for an existing
// account whose password you're deliberately overwriting. This produces a
// `password_changed` event in the notification email, distinct from `new`,
// and gets the same customData.expiresAt treatment new accounts get.
//
// @allow-forbidden: true
// (updateUser — which is how a password rotation actually happens — is
// high-risk by default in DCL, same as dropUser: an account's password
// changing unexpectedly needs the same review a new account creation gets.)

export async function up(db, client) {
  const adminDb = client.db('admin');
  const username = 'app_readonly';

  await adminDb.command({ updateUser: username, pwd: 'CHANGE_ME_ON_FIRST_LOGIN' });

  return { passwordSet: 'rotated', allUsernames: [username] };
}
