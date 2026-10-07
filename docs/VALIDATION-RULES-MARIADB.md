# MariaDB Validation Rules Reference

Audited against `src/adapters/mariadb-adapter.js` on 2026-09-10. Every rule below is
copied from the live `getValidationRules()` / `validateContent()` implementation —
not from memory, not from the older `VALIDATION-RULES-REFERENCE.md` (which had drifted
from the code; see [Superseded doc](#superseded-doc) at the bottom).

## How a file gets checked

`validate -c <config>` — and `up`/`sync`/`up-all` right before they execute anything —
run these checks. Which files: every `.sql` file in `migrationsDir` except `R__*`
(repeatable/DCL scripts, ignored in a versioned project with a warning), in the same
order `up` runs them. `up`/`sync`/`up-all` and `validate --pending-only` only report on
the migrations that haven't been applied yet (all files are still read, so the
cross-file FK check knows what earlier migrations created). Per file, in this order:

1. **Annotation parse** — leading comment block only (stops at first non-comment,
   non-blank line). Recognizes `-- @allow-dangerous: true`, `-- @allow-forbidden: true`,
   `-- @allow: CODE1,CODE2`, `-- @skip-syntax-check: true`. Annotations can only
   **escalate** permission (add allowances) — they can never downgrade a CLI flag.
2. **SQL syntax check** (`node-sql-parser`, MariaDB dialect) — Up section, Down section,
   and any Sanity `PreCheck`/`PostCheck` SQL, each checked independently.
3. **Structural checks** — orphan drops, FK reference integrity. FK integrity and SQL
   syntax errors are `errors` that cannot be bypassed by any flag. Orphan-drop
   (`ORPHAN_DROP_DOWN`/`ORPHAN_DROP_UP`) is now smarter: it auto-allows when a
   dropped table is recreated in the migration's other section (a genuine
   self-contained reverse migration), and otherwise **can** be bypassed via
   `--allow-dangerous` or `--allow CODE` — see
   [Structural errors](#structural-errors).
4. **Forbidden operations** — blocks unless `--allow-forbidden` / matching `--allow CODE`.
5. **Dangerous operations** — blocks unless `--allow-dangerous` / matching `--allow CODE`.
6. **`INSERT...SELECT`** — special-cased outside the rule tables (see below).
7. **Warnings** — never blocks.
8. **Suspicious identifier names** — never blocks.
9. **Performance checks** — never blocks.

A file is `valid: true` only if steps 3–6 produced nothing left un-allowed.

---

## Forbidden operations (🔴)

Bypass: `--allow-forbidden` (all) or `--allow CODE1,CODE2` (per-code). Bypassing is
logged as `[FORCE ALLOWED]` in the warnings list — it downgrades severity, it does not
delete the evidence.

### Always active

| Code | Pattern (essence) | Message |
|---|---|---|
| `DROP_DATABASE` | `DROP\s+DATABASE` | Drop database is forbidden |
| `DROP_SCHEMA` | `DROP\s+SCHEMA` | Drop schema is forbidden |
| `INTO_OUTFILE` | `SELECT ... INTO OUTFILE` | Export data to file is forbidden |
| `LOAD_DATA` | `LOAD DATA [LOCAL] INFILE` | Load data from file is forbidden |
| `INTO_DUMPFILE` | `INTO DUMPFILE` | Export data is forbidden |
| `SHUTDOWN` | `SHUTDOWN` (statement-terminal, not substring) | Shutdown database is forbidden |
| `RESET_MASTER` | `RESET MASTER` | Reset master is forbidden |
| `RESET_SLAVE` | `RESET SLAVE` | Reset slave is forbidden |
| `STOP_SLAVE` | `STOP SLAVE` | Stop replication is forbidden |
| `CHANGE_MASTER` | `CHANGE MASTER` | Change master config is forbidden |
| `SET_GLOBAL` | `SET GLOBAL` | Change global settings is forbidden |
| `KILL` | `KILL CONNECTION\|QUERY` | Kill connection/query is forbidden |

**Smart allowance for `DROP_DATABASE`/`DROP_SCHEMA`:** if `Up` has `CREATE DATABASE`
and `Down` has the matching `DROP DATABASE` (and `Up` itself has no drop), it's
auto-allowed with a `✅ [ALLOWED]` note — this is the expected rollback shape for a
migration whose whole job is creating a database. A `DROP DATABASE` sitting in `Up`
is always forbidden regardless, requiring `@allow-forbidden`.

### DDL project only (`mode !== 'repeatable'`)

These exist to keep permission/user management **out of DDL** and in DCL instead:

| Code | Pattern | Message |
|---|---|---|
| `CREATE_USER` | `CREATE USER '...'` | User management should be in DCL project |
| `DROP_USER` | `DROP USER [IF EXISTS] '...'` | User management should be in DCL project |
| `ALTER_USER` | `ALTER USER '...'` | User management should be in DCL project |
| `SET_PASSWORD` | `SET PASSWORD FOR` | Password management should be in DCL project |
| `GRANT` | `GRANT ... ON` | Permission management should be in DCL project |
| `REVOKE` | `REVOKE ... ON` | Permission management should be in DCL project |
| `FLUSH_PRIVILEGES` | `FLUSH PRIVILEGES` | Permission management should be in DCL project |

### DCL project only (`mode === 'repeatable'`)

Split into two tiers — this is the inverse direction of the rules above (schema
changes don't belong in DCL):

**`dclReverse` — cannot be bypassed at all, not even with `--allow-forbidden`.**
Only matches at statement-start position (`(?:^|;)\s*...`) so it doesn't false-positive
on privilege names like `GRANT CREATE TABLE ...`:

`CREATE_TABLE_IN_DCL`, `ALTER_TABLE_IN_DCL`, `DROP_TABLE_IN_DCL`, `CREATE_INDEX_IN_DCL`,
`DROP_INDEX_IN_DCL`, `CREATE_VIEW_IN_DCL`, `ALTER_VIEW_IN_DCL`, `DROP_VIEW_IN_DCL`,
`CREATE_ROUTINE_IN_DCL`, `DROP_ROUTINE_IN_DCL`, `CREATE_TRIGGER_IN_DCL`,
`DROP_TRIGGER_IN_DCL`, `RENAME_TABLE_IN_DCL`

**`dclHighRisk` — irreversible or credential-sensitive, requires `@allow-forbidden: true` in-file:**

| Code | Message |
|---|---|
| `DROP_USER` | DROP USER is irreversible |
| `ALTER_USER` | password change |
| `SET_PASSWORD` | password change |
| `REVOKE` | may remove critical permissions |

---

## Dangerous operations (🟠)

Bypass: `--allow-dangerous` (all), `--allow CODE` (per-code), the file's `-- @allow:`
annotation, or the config's `validation.allow` entry for that file. Only checked against
the **Up section** (or full file content for `R__` files with no `Up`/`Down` markers) —
rollback code in `Down` is expected to contain destructive ops and is not scanned.

Rules are matched **per statement** (the section is split on `;` after comments and
string literals are removed), so "has no `WHERE`" means *that statement* has none — a
`WHERE` in another statement can't hide it, and one in the same statement is always
seen. Table names may be schema-qualified (`app.users`) or backticked.

| Category | Code | Message | Suggestion |
|---|---|---|---|
| dataLoss | `TRUNCATE_TABLE` | Will clear all data (`TABLE` keyword optional: `TRUNCATE logs`) | `DELETE FROM ... WHERE ...` instead |
| dataLoss | `DROP_TABLE` | `DROP TABLE` in Up of a table that exists — created by an earlier migration or listed in `validation.existingTables` — when Down doesn't recreate it. Only `validate`/`up`/`sync` (which see every file) can tell; see [Dropping tables](#dropping-tables-cross-file) | Confirm unused + backup; approve with `@allow: DROP_TABLE` |
| blocking | `LOCK_TABLE` | Will block all queries | Consider transaction isolation / row locks |
| blocking | `ALTER_TABLE_MODIFY` | `MODIFY`/`CHANGE COLUMN` may rebuild table, long lock | Test in staging, consider `pt-online-schema-change` |
| blocking | `ALTER_TABLE_REBUILD` | `ENGINE=`/`CONVERT TO CHARACTER SET` needs full rebuild | Use `pt-online-schema-change` for large tables |
| blocking | `SELECT_FOR_UPDATE` | Exclusive row lock | Confirm lock is needed / optimistic locking |
| blocking | `LOCK_IN_SHARE_MODE` | Shared row lock | Confirm shared lock is needed |
| bulkOperation | `DELETE_ALL` | A `DELETE` statement with no `WHERE` and no `LIMIT` — incl. `DELETE FROM app.t` and `DELETE t FROM t …` | Add `WHERE` |
| bulkOperation | `UPDATE_ALL` | An `UPDATE` statement (incl. multi-table `UPDATE … JOIN`) with no `WHERE` and no `LIMIT`. `INSERT … ON DUPLICATE KEY UPDATE` is not an UPDATE statement and isn't flagged | Add `WHERE` |
| schemaChange | `DROP_COLUMN` | Permanently deletes column data — `DROP COLUMN x` or bare `DROP x` (the `COLUMN` keyword is optional), in any clause of the `ALTER`. `DROP INDEX/KEY/FOREIGN KEY/PRIMARY KEY/CONSTRAINT…` are not columns | Confirm unused first |
| schemaChange | `RENAME_TABLE` | May break applications | Confirm callers updated |
| schemaChange | `ALTER_RENAME` | `ALTER TABLE ... RENAME TO` — same risk as above | Confirm callers updated |
| schemaChange | `MODIFY_COLUMN` | May cause data conversion failure | Test in staging |
| schemaChange | `CHANGE_COLUMN` | May cause data conversion failure | Test in staging |
| schemaChange | `DROP_INDEX` | May affect query performance | Confirm unused |
| schemaChange | `DROP_KEY` | `DROP [PRIMARY] KEY` — may affect data integrity | Confirm FK relations handled |
| schemaChange | `DROP_FOREIGN_KEY` | Removes a data integrity constraint | Confirm app-layer validation exists |

### `INSERT...SELECT` (handled outside the rule tables)

Statement-level check (split on `;`, only the *main* `SELECT` after `INSERT INTO` counts —
subqueries inside it don't trigger a second match):

- Has a **top-level** `WHERE` or `ON DUPLICATE KEY UPDATE` → **warning only**
  (`INSERT...SELECT with WHERE may briefly lock source rows`).
- No `WHERE` at all → **dangerous**, code `INSERT_SELECT` — "will lock entire source table."

---

## Structural errors

| Code | Trigger | Bypassable? |
|---|---|---|
| `SQL_SYNTAX_ERROR` / `SQL_SYNTAX_ERROR_DOWN` | `node-sql-parser` rejects the Up/Down SQL | No |
| `SANITY_SQL_SYNTAX_ERROR` | Sanity `PreCheck`/`PostCheck` SQL fails to parse | No |
| `INVALID_STATEMENT_TIMEOUT` | `-- @statement-timeout-sec:` isn't a whole number of seconds | No — fix the file |
| `MISSING_UP_MARKER` | The file has no `-- +migrate Up` marker at all. `up` used to skip such a file without running or recording it, so it stayed pending forever and a later `sync` reported "Applied 0" as success; now both `validate` and `up` reject it. (An Up marker with nothing under it is a deliberate no-op migration and is recorded as applied.) | No — fix the file |
| `MISSING_DOWN` | `Down` is empty/missing and `Up` contains a real operation (`CREATE`/`ALTER`/`DROP TABLE`, `CREATE INDEX`, `INSERT INTO`) — see [Warnings](#warnings--never-block) for the non-blocking case where `Up` has no real operations. Mirrors the MongoDB adapter's equivalent check — both now block equally; this used to be warning-only here (resolved [discussion item #1](#discussion-items)). | No |
| `ORPHAN_DROP_DOWN` | `Down` drops a table `Up` never created | **Yes** — `--allow-dangerous` / `--allow ORPHAN_DROP_DOWN` |
| `ORPHAN_DROP_UP` | `Up` drops a table that — as far as `validate`/`up`/`sync` can see across all files — **doesn't exist**: no earlier migration created it and it isn't in `validation.existingTables`. Usually a typo. (A table that *does* exist is `DROP_TABLE` instead.) When a file is checked on its own, without the other files, any table this file didn't create counts. **Auto-allowed with no flag** if `Down` recreates that same table (a self-contained reverse migration for a table an earlier file created) — resolves [Bug B](#bug-b--orphan_drop_up-has-no-idea-down-exists) below. Otherwise bypassable the same way as `ORPHAN_DROP_DOWN`. | **Yes**, or auto-allowed |
| `FK_REFERENCES_DROPPED_TABLE` | A FK in `Up` references a table dropped in the same `Up` | No |
| `FK_UNRESOLVED_REFERENCE` | (cross-file) FK references a table never created by any prior migration file, in run order — e.g. a table that predates this tool or was onboarded via `baseline` | **Yes** — `--allow-dangerous` / `--allow FK_UNRESOLVED_REFERENCE`, or the referencing file's `@allow` |

**SQL syntax check is silently skipped** (with a `⚠️ syntax-check-skipped` warning,
not an error) when the SQL contains:
- `DELIMITER` (stored procedures/functions/triggers — parser doesn't support it)
- DCL keywords: `CREATE/DROP/ALTER USER`, `GRANT`, `REVOKE`, `FLUSH PRIVILEGES`, `SET PASSWORD FOR`
- `ENUM(...)`, `SET(...)` column types, or `VALUES(...)` function (`ON DUPLICATE KEY UPDATE`)
- Sanity-block SQL using `DATABASE()`
- File has `-- @skip-syntax-check: true`

This means a non-trivial fraction of real-world MariaDB SQL (anything with a stored
procedure, any DCL, any `ENUM`/`SET` column) **never gets syntax-checked at all.**

---

### Dropping tables (cross-file)

`validate`, `up` and `sync` read every migration file, so for each file they know which
tables exist before it runs (created by earlier files and not dropped since, plus
`validation.existingTables`). A `DROP TABLE` in Up is then one of:

| The table… | Result |
|---|---|
| is recreated by this file's Down | auto-allowed (self-contained reverse migration) |
| exists (earlier migration / `existingTables`) | 🟠 `DROP_TABLE` — real data loss, needs approval |
| exists nowhere | 🔴 `ORPHAN_DROP_UP` — check the name |

### Config-level allowances and existing tables

```javascript
// config.js
validation: {
  // Tables that exist without a migration creating them (pre-existing or onboarded
  // via baseline) — used by FK_UNRESOLVED_REFERENCE and the DROP TABLE check
  existingTables: ['legacy_users', 'audit_log'],
  // Per-file approvals kept in config instead of in the file — e.g. for a file that
  // is already applied (editing it would trip the checksum gate)
  allow: {
    '20260101000005-drop-legacy.sql': ['DROP_TABLE']
  }
}
```

An `allow` entry naming a file that doesn't exist (renamed, typo) is reported as a
warning. Allowances from config are printed in the run log like any other.

---

## Warnings (🟡) — never block

| Trigger | Message |
|---|---|
| `ALTER TABLE ... ADD COLUMN` | May take long on large tables |
| `ADD ... NOT NULL` without `DEFAULT` | Should have a DEFAULT value |
| `AUTO_INCREMENT = n` | Manual AUTO_INCREMENT may cause ID conflicts |
| `ENGINE = MyISAM` | MyISAM has no transactions, use InnoDB |
| `CHARSET = latin1` or `utf8` (not `utf8mb4`) | Recommend `utf8mb4` |
| `FLOAT` / `DOUBLE` | Precision issues — use `DECIMAL` for money |
| `DATETIME` without `(n)` precision | Microseconds get truncated |
| `ON DELETE CASCADE` | May cause cascading deletes |
| `ON UPDATE CASCADE` | May cause cascading updates |
| `CREATE [UNIQUE] INDEX ... ON ...` | May take long on large tables (MariaDB 10.4+ does this online) |
| Missing/empty `Down` section (DDL mode only) | `⚠️ DOWN migration is empty or missing` — **warning, not error** |

---

## Suspicious identifier names (🟡)

Any table/column identifier (matched via backtick-quoted names, or names following
`CREATE/ALTER/DROP/TRUNCATE TABLE` / `ADD/DROP/MODIFY/CHANGE COLUMN`) whose lowercase
form **contains** one of these keywords gets flagged — this exists to catch cases where
a legitimate column name accidentally looks like a dangerous operation and could
confuse a human reviewer skimming the diff:

`drop_database`, `dropdatabase`, `drop_schema`, `dropschema`, `truncate`, `shutdown`,
`reset_master`, `reset_slave`, `grant_all`, `revoke_all`, `create_user`, `drop_user`,
`delete_all`, `deleteall`, `purge`, `destroy`, `remove_all`, `removeall`, `wipe`, `wipeall`

---

## Performance checks (🔶) — never block

Thresholds are overridable via `config.performance.thresholds`.

| Code | Default threshold | Trigger |
|---|---|---|
| `MIGRATION_TOO_LONG` | 50,000 chars | Whole-file length |
| `QUERY_TOO_LONG` | 5,000 chars | Any single statement |
| `TOO_MANY_STATEMENTS` | 50 | Statement count in one file |
| `TOO_MANY_INDEXES` | 5 | `CREATE INDEX` count in one file |
| `MULTIPLE_INDEXES_SAME_TABLE` | >1 on same table | Distinct `CREATE INDEX ... ON t` per table |
| `TOO_MANY_ALTER_TABLES` | 10 | `ALTER TABLE` count |
| `TOO_MANY_JOINS` | 5 per query | `JOIN` count in one statement |
| `TOO_MANY_SUBQUERIES` | 3 per query | `(SELECT ...)` count in one statement |
| `COMPLEX_INSERT` | 20 columns | Column count in `INSERT INTO t (...)` |
| `SELECT_STAR` | — (always warns) | `SELECT * FROM` present |
| `ORDER_BY_NO_LIMIT` | — (always warns) | `SELECT ... ORDER BY` with no `LIMIT` |

---

### Known parser limitation

`node-sql-parser` rejects some valid MariaDB syntax — e.g. `UPDATE … ORDER BY … LIMIT n`
(batched updates) and `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` — as `SQL_SYNTAX_ERROR`.
Add `-- @skip-syntax-check: true` to such a file; the rule checks above still run.

Some forms it doesn't know are rewritten for the check only (the SQL that runs is
unchanged), so they're checked instead of refused: `ADD [CONSTRAINT name] UNIQUE [INDEX|KEY]`
is checked as `ADD INDEX`, and `IF [NOT] EXISTS` on `ADD INDEX`, `ADD UNIQUE`,
`ADD PARTITION`, `CREATE INDEX`, `DROP COLUMN`, `DROP INDEX`, `DROP KEY`,
`DROP CONSTRAINT`, `DROP PARTITION` and `MODIFY` / `CHANGE COLUMN` is ignored.

---

## String-literal false-positive protection

Before any pattern is tested, `normalizeSQL()` replaces every string literal with a
`'__STRING__'` placeholder and strips comments — so a *value*, not a *statement*, never
trips a rule:

```sql
INSERT INTO log VALUES ('User tried to DROP DATABASE');  -- does NOT trigger DROP_DATABASE
DROP DATABASE production;                                 -- DOES trigger
```

Covered by `normalize-pattern.test.js` (7 tests for this specifically).

---

## FK integrity validation (DDL only)

Two independent layers, both automatic, both DDL/versioned-mode only (DCL/repeatable
skips FK checking entirely):

| Layer | When | Code |
|---|---|---|
| Same-file | Per-file, during `validate` or `up` | `FK_REFERENCES_DROPPED_TABLE` |
| Cross-file | Whole-directory `validate` only, files in filename order | `FK_UNRESOLVED_REFERENCE` |

### `FK_REFERENCES_DROPPED_TABLE`

Triggers when, within one file's `Up` section, `DROP TABLE X` appears **before** a
`FOREIGN KEY ... REFERENCES X`:

```sql
-- +migrate Up
DROP TABLE IF EXISTS products;

CREATE TABLE order_items (
    product_id BIGINT,
    CONSTRAINT fk_items_product
        FOREIGN KEY (product_id) REFERENCES products(id)  -- ❌ products was just dropped above
);
```

### `FK_UNRESOLVED_REFERENCE`

Triggers when the referenced table was never `CREATE TABLE`'d by *any* migration file
up to and including this one, in filename order — catches migrations written or
reordered out of dependency order:

```sql
-- 20260101000001-create-orders.sql
-- +migrate Up
CREATE TABLE orders (
    customer_id BIGINT,
    CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id) REFERENCES customers(id)  -- ❌ customers doesn't exist yet
);
-- 20260101000002-create-customers.sql  ← too late
```

Also catches: `ALTER TABLE ... ADD FOREIGN KEY` to a table that was never created;
multiple unresolved FKs in one `CREATE TABLE` (each reported independently, not just
the first); and `RENAME TABLE orders TO orders_legacy` making `orders` unavailable to
any FK written afterward.

### Resolution rules at a glance

| Situation | Resolvable? |
|---|---|
| Created by an earlier migration file | ✅ |
| Created earlier in the same file | ✅ (same-file self-reference is fine) |
| Self-referential FK (table → itself, e.g. `parent_id`) | ✅ |
| Dropped by an earlier migration file | ❌ |
| Dropped earlier in the same `Up` section | ❌ |
| Renamed away (`RENAME TABLE X TO Y`) — old name `X` | ❌ (new name `Y` is fine) |
| Referenced schema-qualified (`mydb.users`) | ✅ — schema prefix is stripped, only table name compared |
| FK inside a `CREATE PROCEDURE`/`FUNCTION` body | ✅ not checked — routine bodies are stripped before FK extraction |
| FK inside `Down` | ✅ not checked — only `Up` is scanned |

### Related severities

- `ON DELETE CASCADE` / `ON UPDATE CASCADE` → 🟡 warning only (cascading-delete risk awareness).
- `DROP FOREIGN KEY` → 🟠 dangerous, code `DROP_FOREIGN_KEY`.

### Fixtures

`test-fixtures/mariadb/fk-test/ddl/` — valid FK chain (customers → orders → order_items,
self-reference). `test-fixtures/mariadb/fk-test/ddl-bad/` — five deliberately-broken
variants, one per error shape above.

---

## Confirmed logic bugs (traced by hand, not inspection guesses)

### Bug A — `FK_REFERENCES_DROPPED_TABLE` is order-blind within one file

The same-file check (`validateContent()` step 2c) is:

```js
const fkRefs = this.extractFKReferences(upSQL);
const droppedInUpSet = new Set(droppedTablesInUp.map(t => t.toLowerCase()));
for (const fk of fkRefs) {
  if (droppedInUpSet.has(fk.referencedTable)) { /* push FK_REFERENCES_DROPPED_TABLE */ }
}
```

It only checks **set membership** — "is this table dropped *anywhere* in `Up`" — never
statement **order**. So a perfectly valid, correctly-ordered migration false-positives:

```sql
-- +migrate Up
DROP TABLE IF EXISTS users;              -- drop the old one
CREATE TABLE users (id BIGINT PRIMARY KEY);  -- recreate it
CREATE TABLE orders (
    user_id BIGINT,
    FOREIGN KEY (user_id) REFERENCES users(id)  -- references the NEW users — this is fine SQL
);
```
`users` is in `droppedTablesInUp` (it was dropped, further up the file) **and** the FK
references `users` → flagged as `FK_REFERENCES_DROPPED_TABLE`, even though by the time
`orders` is created, `users` exists again. This is a structural error — **unbypassable,
not even with `--allow-forbidden`.**

**Worth noting:** the *cross-file* checker (`validateCrossFileFKDependencies()`) does
**not** have this bug — it merges `createdNow` into `availableNow` regardless of
`droppedNow`, so the same drop-then-recreate-then-reference pattern is correctly
accepted there. The two FK checks are inconsistent with each other on the exact same
input shape.

### Bug B — `ORPHAN_DROP_UP` has no idea `Down` exists

```js
// createdTables comes from Up only
for (const dropped of droppedTablesInUp) {
  if (!createdTables.map(t => t.toLowerCase()).includes(dropped.toLowerCase())) {
    errors.push({ code: 'ORPHAN_DROP_UP', ... });
  }
}
```

This check never looks at `Down` at all. So the exact reverse-migration shape you asked
about — **`Up` drops a table that existed from an earlier migration, `Down` correctly
recreates it** — is unconditionally blocked:

```sql
-- +migrate Up
DROP TABLE legacy_orders;   -- table created by an earlier migration file

-- +migrate Down
CREATE TABLE legacy_orders (
    id BIGINT PRIMARY KEY,
    ...  -- fully correct rollback
);
```
This is structurally sound — `Down` genuinely undoes `Up` — but `ORPHAN_DROP_UP` fires
anyway, because the check only asks "was this created **in Up**," never "does **Down**
recreate it." No CLI flag or annotation helps; it's a structural `errors` entry.

**Compare with `DROP_DATABASE`'s smart allowance** (the *forbidden*-tier check, a
different code path): that one *does* look at `Down` — `hasDropDatabaseInDown` is part
of its auto-allow condition. The plain-`DROP TABLE` structural check was never given
the equivalent Down-awareness. This looks like an asymmetry between two checks that
conceptually should behave the same way, not a deliberate design choice.

**What already works correctly, confirmed by re-reading + a live `--allow-dangerous`
test run:** any dangerous/forbidden operation sitting in `Up` — including one with no
paired `Down` at all — does correctly require `--allow-dangerous`/`--allow-forbidden`
or the matching annotation before it validates clean. That part of the "does Up ever
sneak something past review" question is fine; Bugs A and B are specifically about the
**structural** (orphan-drop/FK) layer, which sits outside the allow/annotation
mechanism entirely by design — and in these two cases, that design overreaches into
blocking valid migrations rather than just catching invalid ones.

---

## Discussion items

Things found during this audit worth a human decision, not yet changed:

1. **`docs/VALIDATION-RULES-REFERENCE.md` was stale and materially wrong** — it listed
   `TRUNCATE_TABLE` as *forbidden* (it's actually *dangerous*), listed a `DROP_TABLE`
   dangerous code that **does not exist anywhere in the source**, and used code names
   (`DELETE_WITHOUT_WHERE`, `DELETE_FROM`, `UPDATE_WITHOUT_WHERE`) that don't match the
   real codes (`DELETE_ALL`, `UPDATE_ALL`) — so copy-pasting `--allow DELETE_WITHOUT_WHERE`
   from that doc would silently do nothing. It's been replaced with a short pointer to
   this file and its MongoDB counterpart.
2. **Orphan-drop and FK errors have no bypass path at all**, not even `--allow-forbidden`.
   That's defensible for FK integrity (a broken reference is just wrong), but it also
   means there is **no way to write a "drop this legacy table that a much earlier
   migration created" cleanup migration** without either (a) faking a `CREATE TABLE`
   for it in the same file first, or (b) using `baseline` to sidestep validation
   entirely. Worth deciding whether `ORPHAN_DROP_UP` specifically should be
   downgradable via annotation for intentional cleanup migrations.
3. **`DELETE_ALL`/`UPDATE_ALL` pattern requires the statement to end at `;` or end-of-file**
   (`(?:;|$)`) with nothing between `SET ...` and the terminator other than the check
   itself allowing `WHERE` anywhere before it via negative lookahead. A `WHERE` clause
   split across a very long multi-line statement should still match correctly, but this
   wasn't stress-tested against multi-statement files where a later statement's `WHERE`
   could theoretically interact with the lookahead across statement boundaries — worth a
   dedicated test case rather than trusting the regex by inspection.

---

## Superseded doc

`docs/VALIDATION-RULES-REFERENCE.md` now just points here and to
`docs/VALIDATION-RULES-MONGODB.md`. Do not resurrect content from its git history
without re-checking it against the adapter source — that's exactly how it went stale.
