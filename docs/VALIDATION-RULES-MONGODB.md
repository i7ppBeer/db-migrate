# MongoDB Validation Rules Reference

Audited against `src/adapters/mongodb-adapter.js` on 2026-09-10. Same audit pass as
[VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md) — read directly from
`getValidationRules()` / `validateContent()`, not from the older stale reference doc.

## How a file gets checked

Same nine-step pipeline as MariaDB (annotation parse → syntax check → structural checks
→ forbidden → dangerous → warnings → suspicious names → performance), with two
MongoDB-specific differences called out below: the syntax check method, and that
**missing/empty `down()` is a hard error here, not a warning** (see
[Unbypassable structural errors](#unbypassable-structural-errors)).

Annotation syntax is JS-comment style: `// @allow-dangerous: true`,
`// @allow-forbidden: true`, `// @allow: CODE1,CODE2` — otherwise identical semantics
to MariaDB's `-- @...` annotations (leading-comment-block only, escalate-only merge
with CLI flags).

---

## Forbidden operations (🔴)

Bypass: `--allow-forbidden` / `--allow CODE`. Every pattern below has both a **method-call
form** (`.dropDatabase()`) and, where relevant, a **command-object form**
(`dropDatabase: true` inside `db.command({...})`) — both are matched as separate codes.

### Always active

| Code | Pattern (essence) | Message |
|---|---|---|
| `DROP_DATABASE` | `.dropDatabase(...)` | Drop database is forbidden |
| `DROP_DATABASE_CMD` | `dropDatabase: true\|1` | Drop database is forbidden |
| `SHUTDOWN` | `shutdown: true\|1` (command form) | Shutdown database is forbidden |
| `SHUTDOWN_FUNC` | `.shutdown(...)` | Shutdown database is forbidden |
| `REPL_RECONFIG` | `replSetReconfig:` | Replica Set reconfig is forbidden |
| `REPL_STEPDOWN` | `replSetStepDown:` | Force stepdown Primary is forbidden |
| `SET_PARAMETER` | `setParameter:` | Change system parameters is forbidden |

**Smart allowance for `DROP_DATABASE`/`DROP_DATABASE_CMD`:** allowed automatically in
`down()` when `up()` initializes the database (`createCollection` or a
`_db_metadata`-style marker) and `down()`'s drop isn't also duplicated in `up()`.
A `dropDatabase` sitting in `up()` always requires `@allow-forbidden`.

### DDL project only (`mode !== 'repeatable'`)

| Code | Message |
|---|---|
| `CREATE_USER` / `CREATE_USER_CMD` | User management should be in DCL project |
| `DROP_USER` / `DROP_USER_CMD` | User management should be in DCL project |
| `UPDATE_USER` / `UPDATE_USER_CMD` | User management should be in DCL project |
| `GRANT_ROLES` / `GRANT_ROLES_CMD` | Permission management should be in DCL project |
| `REVOKE_ROLES` / `REVOKE_ROLES_CMD` | Permission management should be in DCL project |
| `CREATE_ROLE` / `CREATE_ROLE_CMD` | Role management should be in DCL project |
| `DROP_ROLE` / `DROP_ROLE_CMD` | Role management should be in DCL project |
| `UPDATE_ROLE` / `UPDATE_ROLE_CMD` | Role management should be in DCL project |

### DCL project only (`mode === 'repeatable'`)

**`dclReverse` — never bypassable, not even with `--allow-forbidden`:**

| Code | Message |
|---|---|
| `CREATE_COLLECTION_IN_DCL` | Schema changes should be in DDL project |
| `CREATE_INDEX_IN_DCL` | Index management should be in DDL project |
| `RENAME_COLLECTION_IN_DCL` / `RENAME_COLLECTION_IN_DCL_CMD` | Schema changes should be in DDL project |

**`dclHighRisk` — requires `@allow-forbidden: true` in-file:**

| Code | Message |
|---|---|
| `DROP_USER` / `DROP_USER_CMD` | dropUser is irreversible |
| `UPDATE_USER` / `UPDATE_USER_CMD` | includes password change |

---

## Dangerous operations (🟠)

Bypass: `--allow-dangerous` / `--allow CODE`. Checked only against `up()`'s body — the
scanner finds where `down()` starts in the file and only scans content **before** that
point, so rollback code isn't flagged for containing destructive calls.

| Category | Code | Message | Suggestion |
|---|---|---|---|
| dataLoss | `DROP_COLLECTION` | `.drop()` deletes entire collection | Confirm deletion + backup exists |
| dataLoss | `DELETE_ALL` | `deleteMany({})` deletes all documents | Add a query condition |
| dataLoss | `REMOVE_ALL` | `remove({})` (deprecated method) deletes all documents | Use `deleteMany` with a condition |
| bulkOperation | `UPDATE_ALL` | `updateMany({}, ...)` updates all documents | Add a query condition |
| bulkOperation | `REPLACE_ONE` | `replaceOne()` fully replaces the document | Consider `updateOne` + `$set` |
| schemaChange | `DROP_INDEX` | May affect query performance | Confirm unused |
| schemaChange | `DROP_INDEXES` | Deletes **all** indexes on the collection | Very dangerous — double check |
| schemaChange | `RENAME_FIELD` | `$rename` may break applications | Confirm callers updated |
| schemaChange | `UNSET_FIELD` | `$unset` permanently deletes the field | Confirm unused first |
| schemaChange | `RENAME_COLLECTION` / `RENAME_COLLECTION_CMD` | May break applications | Confirm callers updated |
| validation | `VALIDATION_ERROR` | `validationAction: 'error'` may cause write failures | Test with `'warn'` first |
| validation | `VALIDATION_STRICT` | `validationLevel: 'strict'` validates all existing docs | Confirm existing data matches schema |

**Smart allowance for `DROP_COLLECTION`:** in DDL mode, a `.drop()` sitting in `down()`
is auto-allowed when every collection it drops was created in this same file's `up()`
(the paired create/drop pattern) — the same "expected rollback shape" logic as MariaDB's
`DROP TABLE`.

---

## Unbypassable structural errors

| Code | Trigger |
|---|---|
| `JS_SYNTAX_ERROR` | See [Syntax check method](#syntax-check-method) below |
| `MISSING_UP_EXPORT` | No exported `up()` (any DDL or DCL mode) |
| `MISSING_DOWN_EXPORT` | DDL mode only: no exported `down()` |
| *(no code)* `missing-down` | **DDL mode only, and this is the sharpest difference from MariaDB:** if `up()` contains `createCollection`/`createIndex`/`insertMany`/`insertOne` and `down()` is empty (or has no method calls at all), this is pushed into `errors` — **it blocks validation.** MariaDB's equivalent check is a `warnings`-only entry and never blocks. See [discussion item #1](#discussion-items). |
| *(no code)* `orphan-drop` | `down()` drops a collection `up()` never created |
| *(no code)* `orphan-drop-in-up` | `up()` drops a collection not created earlier in the same file |

Repeatable (`R__`) DCL files skip all of the above except `MISSING_UP_EXPORT` — `down()`
is optional there (only a `⚠️ down() is optional in repeatable (DCL) mode` warning if absent).

### Syntax check method

MariaDB uses a real SQL parser (`node-sql-parser`). MongoDB migrations are JavaScript,
so `validateJSSyntax()` instead:

1. Strips `import ...;` lines and `export` keywords with **line-anchored regexes**
   (`/^\s*import\s+.*?;?\s*$/gm` etc.) — each regex assumes the statement is on one line.
2. Feeds the result to `new Function(parseTarget)`. This **compiles but never calls**
   the function, so it's a syntax check, not code execution — but it does mean any
   valid syntax `new Function` doesn't happen to support would false-positive.

**Known fragility (see [discussion item #3](#discussion-items)):** a multi-line
`import` —

```js
import {
  ObjectId
} from 'mongodb';
```

— is not fully stripped by the line-anchored regex, leaving `} from 'mongodb';` behind
as a syntax error `new Function` will reject. This has not been confirmed with a live
test yet; it's flagged from code inspection and belongs in the test-gap list.

---

## Warnings (🟡) — never block

| Trigger | Message |
|---|---|
| `.createIndex(...)` | May take long on large collections |
| `background: false` | Will block operations |
| `.aggregate(...)` | May consume lots of resources on large datasets |
| `$lookup:` | May cause performance issues, ensure proper indexes |
| `sparse: true` | Excludes documents with null values from the index |
| `expireAfterSeconds:` | TTL index will auto-delete expired documents |
| `.deleteMany(...)` (any condition) | May affect large amounts of data |
| `.updateMany(...)` (any condition) | May affect large amounts of data |

---

## Suspicious identifier names (🟡)

Collection names, `createCollection('name')` names, index `name:` values, and
declared variable names — lowercased with `_`/`-` stripped — checked for containing:

`dropdatabase`, `drop_database`, `dropdb`, `deleteall`, `delete_all`, `removeall`,
`remove_all`, `shutdown`, `createuser`, `create_user`, `dropuser`, `drop_user`,
`grantrole`, `grant_role`, `revokerole`, `revoke_role`

---

## Performance checks (🔶) — never block

Thresholds overridable via `config.performance.thresholds`.

| Code | Default threshold | Trigger |
|---|---|---|
| `MIGRATION_TOO_LONG` | 50,000 chars | Whole-file length |
| `TOO_MANY_INDEXES` | 5 | `.createIndex(` count |
| `MULTIPLE_INDEXES_SAME_COLLECTION` | >1 | Distinct `.collection('x').createIndex` per collection |
| `TOO_MANY_BULK_OPS` | 10 | `insertMany`/`updateMany`/`deleteMany`/`bulkWrite` count combined |
| `TOO_MANY_LOOKUPS` | 3 | `$lookup:` count |
| `UNBOUNDED_FIND` | — (always warns) | `.find(...)` with no `.limit(`/`.count(`/`.countDocuments(` |
| `SORT_WITHOUT_LIMIT` | — (always warns) | `.sort(...)` with no `.limit(` |
| `COMPLEX_AGGREGATE` | 10 pipeline stages | Count of `$match/$project/$group/...` stage keys |

**Two thresholds are defined but never used:** `maxQueryLength` and
`maxStatementsPerMigration` exist in the config shape (mirroring MariaDB's) but
`checkPerformanceIssues()` never reads them — there is no MongoDB equivalent of
`QUERY_TOO_LONG` or `TOO_MANY_STATEMENTS`. See [discussion item #4](#discussion-items).

---

## String-literal false-positive protection

`normalizeJS()` replaces every string/template literal with a `'__STRING__'`
placeholder and strips comments before any pattern runs:

```javascript
console.log('Warning: dropDatabase is forbidden');  // does NOT trigger DROP_DATABASE
db.dropDatabase();                                    // DOES trigger
```

Covered by 7 dedicated tests in `mongodb-adapter.test.js`.

---

## Discussion items

1. **`missing-down` blocks in MongoDB but only warns in MariaDB — same intent, different
   severity.** Is that deliberate (MongoDB migrations are more often destructive/bulk
   so forcing a rollback path is stricter by design), or drift between two adapters
   that were meant to mirror each other? Worth a decision either way, and worth
   documenting the reason once decided.
2. **Bracket-notation / computed-property bypass.** Every dangerous/forbidden pattern
   assumes dot-call syntax (`.dropDatabase(`) or a literal object key
   (`dropDatabase:`). `db['dropDatabase']()`, `db[\`dropDatabase\`]()`, or a computed
   key (`{['drop' + 'Database']: 1}`) would not match any pattern and would pass
   validation clean. This is a generic limitation of regex-based static analysis (not
   fixable by adding one more regex — someone determined to hide an operation can
   always find a new string-construction trick), but it's worth being explicit in this
   doc that **validation is a lint, not a sandbox** — it catches accidental danger, not
   deliberate obfuscation.
3. **Multi-line `import` syntax-check false-positive**, detailed above — needs a test
   to confirm before deciding whether to fix (e.g. switch to a proper JS parser, or
   make the strip regex `/s`-flag / multi-line aware).
4. **`maxQueryLength`/`maxStatementsPerMigration` are dead config** for MongoDB — either
   wire them up (what would "one statement" even mean for a JS migration — one
   top-level `await` call?) or remove them from the threshold shape so the config
   surface doesn't imply a check that doesn't exist.
5. **No "blocking" severity category for MongoDB**, unlike MariaDB's `LOCK_TABLE` /
   `ALTER_TABLE_MODIFY` / `SELECT_FOR_UPDATE` tier. This is *probably* fine — WiredTiger
   uses document-level locking, not the table-level locks that make MariaDB's `ALTER
   TABLE` dangerous — but it hasn't been explicitly decided that MongoDB has no
   equivalent risk (e.g. a `createIndex` without `background`-style non-blocking build
   on a huge collection, or a long-running unindexed `updateMany` holding a global
   intent lock long enough to matter under heavy write load). Worth a deliberate "we
   checked, MongoDB genuinely doesn't need this tier, because X" note rather than
   silence.

---

See [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md) for the MariaDB side
and its own discussion items (stale old doc, unbypassable orphan-drop, `DELETE_ALL`
regex edge case).
