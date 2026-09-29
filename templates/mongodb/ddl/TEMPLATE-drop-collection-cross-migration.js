// Rename to <timestamp>-remove-legacy-orders.js before use.
//
// Pattern: dropping a collection a DIFFERENT, earlier migration created (not
// this file). `validate` can't see across files, so it can't confirm
// legacyOrders really exists to be dropped — but as long as down() recreates
// exactly what up() dropped, it's auto-allowed with no flag: the migration
// is self-contained and reversible even though the collection's origin isn't
// in this file. See docs/VALIDATION-RULES-MONGODB.md's orphan-drop rows.
//
// If down() does NOT recreate it (a genuinely permanent removal), the
// orphan-drop check needs --allow-dangerous or `// @allow: ORPHAN_DROP_UP`.
//
// Separately — and always, regardless of down() — .drop() is its own
// dangerous op (DROP_COLLECTION, "will delete entire collection"), so this
// file needs --allow-dangerous / `// @allow: DROP_COLLECTION` either way.
// (MariaDB has no equivalent whole-table dangerous-op rule — only the
// orphan-drop structural check applies there. See templates/README.md.)
// @allow-dangerous: true

export async function up(db, client) {
  await db.collection('legacyOrders').drop().catch(() => {}); // idempotent — already gone is fine
}

export async function down(db, client) {
  await db.createCollection('legacyOrders');
}
