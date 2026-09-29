// Rename to R__040_grant_analytics_insert.js before use.
//
// No CHANGE_ME_ON_FIRST_LOGIN here — this only changes roles on an account
// that already exists. Shows up in the notification email as a
// `permissions_updated` event with the before/after role list, no password
// involved.
//
// @allow-forbidden: true
// (grantRolesToUser is high-risk by default in DCL, same tier as dropUser
// and updateUser — permission changes need the same review new accounts get.)

export async function up(db, client) {
  const adminDb = client.db('admin');
  await adminDb.command({
    grantRolesToUser: 'app_analytics',
    roles: [{ role: 'readWrite', db: 'analytics' }]
  });
}
