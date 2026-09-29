# Migration Templates

Copy-paste starting points for common DDL/DCL patterns, one pair of directories
per database type. Every file here has been run through the real
`validateContent()` from `src/adapters/*.js` and validates clean (or clean
with the annotation already included where one is genuinely required) — none
of this is illustrative pseudo-syntax.

```
templates/
├── mariadb/
│   ├── ddl/   config.js + TEMPLATE-*.sql
│   └── dcl/   config.js + TEMPLATE-*.sql   (R__ repeatable scripts)
└── mongodb/
    ├── ddl/   config.js + TEMPLATE-*.js
    └── dcl/   config.js + TEMPLATE-*.js    (R__ repeatable scripts)
```

## How to use one

1. Copy the directory's `config.js` and the template(s) you need into your
   own project, e.g. `test-fixtures/mariadb/my-project/ddl/`.
2. Rename the template — DDL files need a real timestamp prefix
   (`node src/cli.js create <name> -c <config>` generates one, or copy the
   pattern from an existing file); DCL files need `R__<seq>_<name>.{sql,js}`.
3. Edit the table/collection/user names for your actual schema.
4. `node src/cli.js validate -c <config>` before running it for real.

## What's here

| Template | DDL | DCL |
|---|---|---|
| Create a table / collection | `TEMPLATE-create-table.sql` | — |
| Add a column / field | `TEMPLATE-alter-table-add-column.sql` | — |
| Add an index | `TEMPLATE-create-index.sql` | — |
| Drop something an earlier migration created | `TEMPLATE-drop-table-cross-migration.sql` | — |
| Pre-Check / Post-Check (Sanity Check) | `TEMPLATE-with-sanity-check.sql` | — |
| Create a read-only account | — | `TEMPLATE-create-user-readonly.{sql,js}` |
| Create a read-write account | — | `TEMPLATE-create-user-readwrite.{sql,js}` |
| Rotate an existing account's password | — | `TEMPLATE-rotate-password.{sql,js}` |
| Remove an account | — | `TEMPLATE-remove-user.{sql,js}` |
| Grant additional permissions to an existing account | — | `TEMPLATE-grant-additional-permission.sql` / `TEMPLATE-grant-additional-role.js` |

(MongoDB DDL additionally has `TEMPLATE-add-field-to-documents.js` and
`TEMPLATE-drop-collection-cross-migration.js` — same patterns as the MariaDB
equivalents above, split into two files there because collection field
changes and index changes read as separate concerns in Mongo more often than
in SQL.)

## Where MariaDB and MongoDB genuinely differ

Not every asymmetry below is a bug — some are real differences between a
relational and a document engine. Noted per row.

| | MariaDB | MongoDB | Why |
|---|---|---|---|
| Drop-in-`UP` of something not created in this file | Auto-allowed if `DOWN` recreates it, else needs `--allow-dangerous` / `@allow: ORPHAN_DROP_UP` | Same mechanism, same codes | Deliberately unified this session — see docs/E2E-SCENARIOS.md |
| Dropping an entire table/collection | No dedicated dangerous-op rule — only the orphan-drop structural check applies | `DROP_COLLECTION` is its own 🟠 dangerous op, needs `--allow-dangerous` on top of any orphan-drop allowance | Asymmetry, not yet reconciled — see [templates/mongodb/ddl/TEMPLATE-drop-collection-cross-migration.js](mongodb/ddl/TEMPLATE-drop-collection-cross-migration.js) |
| Signaling a password rotation vs. a new account | Detected automatically from `ALTER USER` vs `CREATE USER` syntax | No equivalent syntax to sniff — the migration's `up()` must explicitly `return { passwordSet: 'rotated' }` | Structural difference (SQL statement kind vs. a driver command with no such distinction) |
| Create-or-update account pattern needing `@allow-forbidden` | Not needed — `CREATE USER IF NOT EXISTS` is one idempotent statement | Needed — the "already exists" branch's `updateUser` is flagged regardless of whether that branch runs (static analysis can't know) | Structural difference (one SQL statement vs. a JS branch) |
| Whole-table FK integrity check | ✅ `FK_REFERENCES_DROPPED_TABLE` / `FK_UNRESOLVED_REFERENCE` | — (no foreign keys in MongoDB) | Real paradigm difference, not a gap |
| Lock Guard (bounded `lock_wait_timeout` + retry) | ✅ | — (no equivalent lock model) | Real paradigm difference |
| `customData.expiresAt` on new/rotated DCL accounts | — | ✅ (`DCL_PASSWORD_EXPIRY_DAYS`) | MongoDB-specific convenience, not ported to MariaDB |

See [docs/VALIDATION-RULES-MARIADB.md](../docs/VALIDATION-RULES-MARIADB.md) and
[docs/VALIDATION-RULES-MONGODB.md](../docs/VALIDATION-RULES-MONGODB.md) for
the full rule tables.
