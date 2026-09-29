// Rename to R__030_remove_legacy_reporting_user.js before use.
//
// Shows up in the run's notification email as a `removed` event — detected
// from a before/after account-state diff, not by parsing this file for
// dropUser. See docs/E2E-SCENARIOS.md.
//
// dropUser is irreversible — needs explicit approval.
// @allow-forbidden: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  try {
    await adminDb.command({ dropUser: 'legacy_reporting_svc' });
  } catch (err) {
    if (err.codeName !== 'UserNotFound') throw err; // idempotent — already gone is fine
  }
}
