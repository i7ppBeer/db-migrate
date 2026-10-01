# End-to-End Scenarios FAQ

Task-oriented Q&A for the scenarios people actually hit: creating an account, removing one, changing a schema, onboarding an existing database, and where MongoDB and MariaDB behave the same or differently. Each answer includes the commands, a flowchart of what the tool does internally, and why it's built that way — not just "run this."

For a flat command cheat-sheet instead, see [QUICKSTART.md](../QUICKSTART.md). For the full existing-database onboarding SOP, see [EXISTING-DATABASE-ONBOARDING.md](EXISTING-DATABASE-ONBOARDING.md).

---

## Q: I want to create a new database account. How, and what actually happens?

Write a `R__*.sql`/`R__*.js` DCL file with `CREATE USER IF NOT EXISTS ... IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'`, then run `dcl`:

```bash
docker compose run --rm migrate create-dcl add-reporting-user -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

**Why `CHANGE_ME_ON_FIRST_LOGIN` instead of a real password in the file**: DCL files are checksum-tracked and typically committed to git. A literal password in a committed file is a leaked credential the moment it's pushed. The placeholder lets the file itself be reviewable and diffable while the actual secret only ever exists at runtime, in memory, for as long as it takes to hand it to the notification email.

```
 R__add_reporting_user.sql
 CREATE USER ... IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
             |
             v
        dcl command runs
             |
             v
   .------------------------.
   |  Checksum changed      |
   |  since last run?       |
   '------------------------'
      | No              | Yes
      v                  v
  Skip file        resolvePlaceholderPasswords()
  entirely         generate a fresh 16-char
                    password, in memory only
                              |
                              v
                 preCheckAccountsExistMariaDB()
                 direct query: does this account
                 already exist?
                    | No                | Yes
                    v                    v
        Execute CREATE USER      Execute anyway
        + GRANT with the         (idempotent SQL) —
        generated password       password NOT changed
                    |                    |
                    v                    v
        recordCredentialEvents()  recordCredentialEvents()
        type: new                 type: no_change
                    |____________________|
                              |
                              v
                 updateChecksum — file now
                 recorded as applied
                              |
                              v
                 captureDCLState() after
                 + diffStates() vs. before
                              |
                              v
                 buildDCLNotificationEvents()
                 merges credential events + diff
                              |
                              v
                 notificationEmailToHTML()
                 renders reports/notification.html
```

**Why the checksum check runs before anything else**: the placeholder gets replaced with a *different* random password every time the file is executed. If the runner re-ran unchanged files on every `dcl` invocation, every `dcl` call would silently rotate every password. The checksum is computed from the file's original, unresolved content (with the literal placeholder text still in it) specifically so that substituting a password doesn't itself look like a change.

**Where the password actually shows up**: nowhere except `reports/notification.html` (or wherever `-o` points), as plaintext, with a note on what the database actually enforces (a forced change on first login only if the statement has `PASSWORD EXPIRE`). Not the console, not a file like the old `/tmp/secret` mechanism, not the migration file. See [DCL-PASSWORD.md](DCL-PASSWORD.md).

---

## Q: I want to remove an account. How does that get detected and reported?

Write a DCL file that drops it — this is a **forbidden** operation by default (it's destructive and irreversible), so it needs an explicit annotation:

```sql
-- @allow-forbidden: true
-- DROP USER is irreversible — approved via @allow-forbidden
DROP USER IF EXISTS 'legacy_reporting_svc'@'%';
FLUSH PRIVILEGES;
```

```javascript
// MongoDB equivalent
export async function up(db, client) {
  const adminDb = client.db('admin');
  try { await adminDb.command({ dropUser: 'legacy_reporting_svc' }); }
  catch (e) { /* already gone — fine, this must stay idempotent */ }
}
```

**Why removal isn't its own CLI command**: DCL has exactly one execution model — run the file's SQL/JS, whatever it says. A dedicated `dcl remove-user <name>` command would be a second, parallel way to mutate accounts that bypasses the checksum-tracked, reviewable file history the rest of DCL depends on. Instead, "remove" is just what a particular file's content *does*.

**How the tool knows an account was removed** — it doesn't parse your SQL for `DROP USER`. It diffs actual database state:

```
 captureDCLState() — snapshot accounts + grants BEFORE running dcl
                              |
                              v
 runner.run() executes every pending/changed R__ file
                              |
                              v
 captureDCLState() — snapshot accounts + grants AFTER
                              |
                              v
 DCLIdempotentChecker.diffStates(before, after)
                              |
                              v
              .--------------------------------.
              |  Account present before,        |
              |  absent after?                  |
              '--------------------------------'
                 | Yes                  | No, still present
                 v                       v
     removedUsers — reported     .--------------------------.
     as a 'removed' event        |  Grants differ            |
                                  |  before vs. after?        |
                                  '--------------------------'
                                     | Yes              | No
                                     v                   v
                     addedGrants / removedGrants   Not reported —
                     — reported as                 nothing changed
                     'permissions_updated'          for this account
```

This is also why a `REVOKE` that leaves the account in place shows up as `permissions_updated`, not `removed` — the diff is purely "what does the database look like now vs. before," not "what statement did you run."

---

## Q: I want to update an existing table's/collection's schema.

Same DDL flow as creating a new table — `create` always generates a fresh timestamped file, you just write `ALTER` instead of `CREATE`:

```bash
docker compose run --rm migrate create add-phone-to-users -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```
```sql
-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL;
-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

Then either `up` (just applies it) or `sync` (applies it **and** reports the diff):

```
 sync command
       |
       v
 status(): compute pending migrations from changelog vs. files
       |
       v
   .----------------------.
   |  pending.length == 0? |
   '----------------------'
      | Yes                        | No
      v                             v
 exit 1 — "nothing to do"   getSchemaSnapshot() BEFORE
 is an error, not success            |
                                      v
                          up(): apply pending migrations,
                          in timestamp order
                                      |
                                      v
                          .----------------------.
                          |  any errors?          |
                          '----------------------'
                             | Yes            | No
                             v                 v
                exit 1, report which   getSchemaSnapshot() AFTER
                migrations DID apply            |
                before the failure              v
                                      diffSchemaSnapshots(before, after)
                                      git-diff-style +/-/~ per table/field
                                                 |
                                                 v
                                      print diff + full real schema
                                      (queried live, not inferred
                                       from files)
                                                 |
                                                 v
                                      buildNotificationEmail():
                                      DDL section = migrations
                                      applied + diff
                                                 |
                                                 v
                                      reports/notification.html
```

**Why `sync` errors out on zero pending migrations instead of exiting 0**: this command exists to be the thing CI/CD calls. If "nothing was pending" and "the deploy succeeded" both exit 0, a pipeline can't tell "we deployed the schema change" from "we deployed nothing, on purpose or by mistake" — e.g. someone pointed it at the wrong environment, or a previous step already applied everything and this run is a no-op that should have been skipped upstream. Forcing a non-zero exit here surfaces that ambiguity as a build failure instead of a silent gap. Details: [DDL-PRODUCTION-SAFETY.md](DDL-PRODUCTION-SAFETY.md).

**Why the before-snapshot happens before `up`, not compared some other way**: `diffSchemaSnapshots` is a pure function over two point-in-time snapshots — it has no idea what SQL ran. That's deliberate: the diff describes *actual resulting state*, so it's correct even if a migration's `up()` does something the file's SQL text doesn't obviously suggest (a stored procedure, a conditional branch in a `.js` migration, etc).

---

## Q: I have an existing database (schema + data already there). How do I bring it under this tool without re-running its history?

Use `baseline` — it's the difference between "this schema exists because we created it" and "this schema exists, we're just telling the tool to start tracking from here":

```bash
docker compose run --rm migrate baseline --all --dry-run -c <ddl-config>   # preview
docker compose run --rm migrate baseline --all -c <ddl-config>             # mark as applied
```

```
 Existing DB — real schema, real data,
 never touched by this tool before
             |
             v
 Write a baseline migration file describing the
 CURRENT schema (CREATE TABLE IF NOT EXISTS ...)
             |
             v
 baseline --all
             |
             v
 INSERT rows into the changelog table:
 "this file is applied"
             |
             v
 The file's SQL/JS is NEVER executed
             |
             v
 status now shows 0 pending —
 database and tool agree on state
             |
             v
 Future work: create new migrations normally
             |
             v
 up only ever applies migrations NEWER than the baseline
```

**Why the SQL never runs**: the tables described in a baseline file already exist with real data in them — actually executing `CREATE TABLE` against a live schema is either a no-op (if you wrote `IF NOT EXISTS`, best case) or destructive (if you didn't). `baseline` sidesteps the question entirely by only writing to the changelog, never touching the schema.

**Why this isn't just "delete the changelog and start over"**: that would also erase the record of *what* the starting point was assumed to be, which is exactly the information a future engineer needs when a later migration's `down()` doesn't behave as expected against a database whose real history predates the tool. DCL doesn't need baselining — it's checksum-driven and idempotent by design, so pointing it at an existing database and running `dcl` is already correct.

Full step-by-step (schema export, writing the baseline file, DCL for existing accounts, validation): [EXISTING-DATABASE-ONBOARDING.md](EXISTING-DATABASE-ONBOARDING.md).

---

## Q: Is MongoDB used the same way as MariaDB?

Same CLI, same command names, same config shape (`type: 'mariadb' | 'mongodb'`), same DDL/DCL split, same notification email. The differences are all in what a migration file's *content* looks like and a handful of features that only make sense for one engine:

| | MariaDB | MongoDB |
|---|---|---|
| DDL file format | `.sql` (`-- +migrate Up` / `Down`) | `.js` (`export async function up/down`) |
| DCL file format | `.sql` (`CREATE USER`/`GRANT`) | `.js` (`adminDb.command({...})`) |
| Schema diff (`sync`) | tables/columns/indexes | collections/fields (inferred) |
| Lock Guard | ✅ (`lock_wait_timeout` + retry, MDL queue) | — (no equivalent lock model) |
| Sanity Check helpers | `SQLChecks` | `MongoDBChecks` |
| DCL password: new/rotated | plaintext in notification email | plaintext in notification email |
| Extra on new DCL accounts | — | `customData.expiresAt` injected (`DCL_PASSWORD_EXPIRY_DAYS`, default 7) |
| FK integrity check (`validate`) | ✅ | — (no foreign keys) |

Everything upstream of "talk to the specific database" — checksum tracking, the diff engine, the notification email, validation's forbidden/dangerous-op rules, `baseline`, multi-instance `*-all` — is shared code that doesn't know or care which adapter it's running against. `src/adapters/mariadb-adapter.js` and `src/adapters/mongodb-adapter.js` are where the two actually diverge.

---

## Q: How does MongoDB get "health-checked"?

Two different things both answer to that name, at two different layers:

### 1. Is the MongoDB *process* reachable at all? (infrastructure level)

`docker-compose.yml` and CI (`.github/workflows/migrations.yml`) both define a container health check that has nothing to do with this tool's own logic — it's Docker/GitHub Actions polling `mongosh --eval 'db.adminCommand({ping:1})'` every few seconds until it succeeds, before letting any step that needs the database start:

```
 docker compose up / CI job starts
             |
             v
 mongo:7 container starts
             |
             v
      +----------------------------------------+
  .-->| health-cmd: mongosh --eval               |
  |   | db.adminCommand({ping:1})                |
  |   | (retried every few sec, up to N times)   |
  |   +----------------------------------------+
  |              |
  | not OK yet   | responds OK
  '--------------+
                 v
 Container marked healthy
             |
             v
 Dependent steps (migrate, test-all) are now allowed to start
```

### 2. Is *this specific migration* safe to consider successful? (Sanity Check)

This is the tool's own feature — optional `preCheck`/`postCheck` functions in a migration file, run via `up --sanity-check` (or `sync --sanity-check`):

```
 up --sanity-check
        |
        v
 preCheck(db, client)
        |
        v
   .-------------------.
   |  preCheck.success? |
   '-------------------'
      | No                    | Yes
      v                        v
 Abort — migration's   Run the migration's up()
 up() never runs                |
                                 v
                          postCheck(db, client)
                                 |
                                 v
                        .--------------------.
                        |  postCheck.success? |
                        '--------------------'
                           | Yes            | No
                           v                 v
                  Committed —        .------------------------.
                  migration stays    |  autoRollback enabled?  |
                  applied            |  (default: yes)         |
                                     '------------------------'
                                        | Yes            | No
                                        v                 v
                           Automatically run     Left applied as-is;
                           down() for this        failure reported for
                           migration               a human to look at
```

MongoDB migrations get this via `MongoDBChecks` (`collectionExists`, `indexExists`, `documentCount`, `hasField`, …) imported from `src/core/sanity-checker.js` — see `test-fixtures/mongodb/test-success/ddl/migrations/20250101000006-add-phone-with-sanity.js` for a full worked example (pre-check the `users` collection exists and `phone` doesn't yet, migrate, post-check every document actually has the field). MariaDB gets the equivalent via `SQLChecks`. Both adapters implement `upWithSanityCheck()` — this is not a MongoDB-only feature, it's symmetric across both database types.

**Why this is a per-migration opt-in feature and not automatic**: what counts as "the migration actually worked" is domain-specific — the tool can confirm a table/collection exists, but only the migration author knows whether "every user row now has a non-null `phone`" or "the index actually reduced a specific query's plan cost" is the real success condition. Sanity Check is the hook for that judgment; nothing runs it unless a migration file defines `preCheck`/`postCheck` and the command is invoked with `--sanity-check`.
