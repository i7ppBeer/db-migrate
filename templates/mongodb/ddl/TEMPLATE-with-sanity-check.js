// Rename to <timestamp>-add-phone-with-sanity.js before use.
// Run with: node src/cli.js up --sanity-check -c <ddl-config>
// (plain `up`/`sync` without --sanity-check just ignores preCheck/postCheck
// and runs up() normally — they're opt-in, per-command, not automatic.)

// Adjust the relative path below to match where this file actually ends up —
// it's resolved from THIS file's own location at runtime, not from here.
// From e.g. test-fixtures/mongodb/my-project/ddl/migrations/, that's
// '../../../../../src/core/sanity-checker.js' (5 levels up to repo root).
import { MongoDBChecks } from '../../../../../src/core/sanity-checker.js';

export async function preCheck(db, client) {
  const details = [];

  const collectionExists = await MongoDBChecks.collectionExists(db, 'users');
  if (!collectionExists) {
    return { success: false, error: 'Collection "users" does not exist. Run create-users migration first.' };
  }
  details.push('✓ Collection "users" exists');

  const hasPhone = await MongoDBChecks.hasField(db, 'users', 'phone');
  if (hasPhone) {
    return { success: false, error: 'Field "phone" already exists in users. Migration may have already run.' };
  }
  details.push('✓ Field "phone" does not exist yet');

  return { success: true, details };
}

export async function up(db, client) {
  await db.collection('users').updateMany(
    { phone: { $exists: false } },
    { $set: { phone: null } }
  );
}

// If this returns success: false, autoRollback (default: on) automatically
// runs down() below.
export async function postCheck(db, client) {
  const allHavePhone = await MongoDBChecks.hasField(db, 'users', 'phone');
  return allHavePhone
    ? { success: true, details: ['✓ All users now have a phone field'] }
    : { success: false, error: 'Some users are still missing the phone field' };
}

export async function down(db, client) {
  await db.collection('users').updateMany({}, { $unset: { phone: '' } });
}
