# DDL Production Risk & Safety Handbook

This is the overview and operations handbook for this repo's "DDL safety" work: what situations can get a production DB stuck, what protections already exist, what's still missing, what to check before running DDL, and how to abort or roll back when something actually goes wrong. Detailed rules live in dedicated documents; this one's job is to tie them together and explain how they relate.

---

## 1. Situations that can get a production DB stuck

### 1.1 MDL queue FIFO deadlock (the incident that started this handbook)

MariaDB's metadata lock (MDL) queue is **FIFO**: once an `ALTER TABLE` is queued waiting for an exclusive lock, every new query that arrives afterward — including plain `SELECT`s — is forced to queue behind it, regardless of whether they're actually compatible with each other. This has nothing to do with "who arrived first" — it happens in both directions:

- **A big DELETE / long transaction arrives first**: the ALTER queues waiting for it to release, and while it waits, new SELECTs queue behind the ALTER → everything stalls.
- **The ALTER arrives first**: the DELETE has to queue for the ALTER before it can even start → same stall.

For a detailed timeline and a comparison of all four scenarios, see the Artifact [Lock Conflict Defense Map](https://claude.ai/code/artifact/58c23985-91d9-45dd-a137-93819f6f940f).

### 1.2 Table-rebuilding ALTERs hold the lock for a long time by themselves

ALTERs that require a full table rebuild (`ALGORITHM=COPY`) — `MODIFY/CHANGE COLUMN`, `ENGINE=`, `CONVERT TO CHARACTER SET` — hold a write-blocking lock for their **entire duration**, which is as long as it takes to rebuild the whole table. Unlike 1.1: even with zero lock contention from anyone else, other queries still have to wait purely because of how long this statement takes to run.

### 1.3 Online DDL collides at the finalization instant

MariaDB's online index creation (10.0+) and instant column add/drop (10.4+) allow concurrent reads/writes for most of their duration, **but the finalization instant** requires briefly upgrading to an exclusive lock. If a long transaction happens to still be uncommitted at that exact moment, it stalls too (though the window is usually short).

### 1.4 "Runs a long time" stacked with "retries repeatedly"

Lock Guard (see Section 3) uses a short timeout plus retries to avoid indefinite queueing, but **a retry re-executes the whole statement — it does not resume**. If an ALTER is the "runs a long time, only needs the lock right at the end" type (1.3), the retry strategy can actually make things worse: it gets interrupted partway through repeatedly and restarts each time, wasting time without ever succeeding.

### 1.5 Mixing DDL and DCL

Writing `CREATE USER`/`GRANT` in a DDL project, or `ALTER TABLE` in a DCL project, doesn't directly lock a table by itself, but it mixes two changes with completely different lifecycles (schema changes vs. permission management) into the same execution flow, making it hard to tell which kind of operation caused a problem when one occurs.

### 1.6 Connecting to the wrong database/environment

An environment variable resolution error in the config causes the connection to actually point at a different database than intended (e.g., thinking it's staging but actually connecting to production). In this situation, every lock protection described earlier is meaningless — because you're doing the right thing in the wrong place.

### 1.7 changelog / checksum out of sync with files on disk

Migration files get deleted or renamed, or changelog data gets manually edited, causing the tool to misjudge what should run and what has already run — it might reapply something, or skip something.

### 1.8 Partial state caused by an interruption (newly found in this audit, recorded here)

`up()` executes in this order: **run the DDL SQL first, then write to the changelog only after it succeeds**. If you interrupt manually between these two steps (Ctrl+C, the process gets killed), the SQL may have already executed successfully but the changelog entry never got written — the next `status`/`up` will still treat it as "pending" and run it again.

This isn't a bug unique to this tool — it's **a limitation shared by all DDL migration tools**: MariaDB DDL statements trigger an implicit commit, so even if you wrap the SQL execution and the changelog write in the same transaction, the DDL itself still commits immediately, and the two steps can never truly be made atomic.

**Mitigation**: write UP blocks to be idempotent wherever possible (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, or check `information_schema` first before deciding whether to run), so a re-run won't error out. The same applies to a migration that *failed* partway — see [§7.4](#74-a-migration-failed-partway-recovering).

---

## 2. Risk from misusing `reset`

The `reset` command (`node src/cli.js reset --yes -c <config>`) **only clears tracking records — it does not touch the actual tables/collections/data**. Misusing it in production:

- After clearing, `up` will treat every migration as pending and rerun them all, but the tables already exist → most likely fails outright (unless every UP is written as `IF NOT EXISTS`).
- If some UP blocks happen to be idempotent and others aren't, you get a "stopped partway through" inconsistent state, which is harder to diagnose than a clean failure.

**This command should basically only ever be used on a dev/test database that's meant to be reset entirely** — this is already documented in `docs/CLI-USAGE-GUIDE.md`; it's repeated here because it directly relates to the "dangerous operation" theme.

---

## 3. Protections currently in place

| Protection | Addresses | Status | Detailed doc |
|---|---|---|---|
| Tiered static validation (🔴 forbidden / 🟠 dangerous / 🟡 warning) + annotations | 1.5 (mixing DDL/DCL), unintentional dangerous operations | ✅ Live — **enforced by `up`/`sync`/`up-all` before anything runs**, on the migrations about to run (until this was added, only the separate `validate` command applied the rules, so a pipeline that just ran `sync` executed anything) | [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md), [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) |
| Lock Guard (session `lock_wait_timeout` + bounded retries) | 1.1, 1.2 (doesn't change execution time, only changes lock-wait time) | ✅ Live (`feat/mariadb-lock-guard`) | [LOCK-GUARD.md](./LOCK-GUARD.md) |
| Sanity Check Pre/PostCheck + Auto-Rollback | Validates the result after execution against expectations, auto-rolls back if it doesn't match | ✅ Live (existing mechanism) | `src/core/sanity-checker.js` |
| `reset` command | One remediation option for 1.7 (paired with a full environment reset) | ✅ Live | See Section 2 |
| `[FORCE ALLOWED]`/`[ALLOWED]` audit trail | Every dangerous operation that gets allowed through (CLI `--allow*` or a file's `@allow`) is printed in the `validate` **and** `up`/`sync` run log instead of passing silently | ✅ Live | Same validation rule docs as above |
| DDL checksum verification | 1.7 variant: an already-applied migration file edited after the fact, previously undetectable | ✅ Live | [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md) Gate R1 |

**This audit also found two existing logic bugs** (which misclassify legitimate migrations as errors) — related to this handbook's theme but the opposite problem: not "a dangerous operation slipping through" but "a safe operation being wrongly blocked." Details in [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md#confirmed-logic-bugs-traced-by-hand-not-inspection-guesses).

---

## 4. Runtime Gate status (R0–R4)

Full spec is in [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md); this is just the
summary. R0–R4 are all live:

| Gate | Checks | Addresses | Status | `--force`-able? |
|---|---|---|---|---|
| R0 Connection identity | Does the connection actually point at the database the config says it should — and does that database exist (instead of being silently created)? | 1.6 | ✅ Live | ❌ No (`createDatabaseIfMissing: true` is a config decision for new environments, not a per-run override) |
| R1 changelog consistency (DDL) | Does the changelog/checksum match the files on disk? | 1.7 | ✅ Live (checksum, orphaned entries, out-of-order all implemented) | Checksum content → ✅ `--allow-checksum-drift`; orphaned/out-of-order → ❌ No |
| R1 changelog consistency (DCL) | Was an applied DCL script deleted from disk? | 1.7 | ✅ Live | ✅ `--accept-removed-dcl` (logged) |
| R2 Long transactions / lock waits | Are there already stuck transactions or MDL waits before execution? | 1.1 | ✅ Live (`up`/`sync`/`up-all`/`down`) | ✅ `--allow-open-transactions` (logged) |
| R3 Writability / replica check | Is the target a read-only replica? | Variant of 1.6 | ✅ Live (every writing command, incl. `dcl`) | Read-only → ❌; lag → warning only |
| R4 Disk/binlog space | Could a large ALTER exhaust available space? | 1.2 | ✅ Live (warning only) | — never blocks |

R0 and R1's orphaned/out-of-order checks deliberately have no override option —
connecting to the wrong database or a changelog that's out of sync with the files on
disk is a "someone needs to go look at this" situation, not a "skip it if the risk is
acceptable" situation. R1's checksum-content check is the one exception in this table:
it's force-able (`--allow-checksum-drift`) because a file being edited after being
applied has a legitimate common cause (fixing a comment/typo), unlike the other checks
here.

---

## 5. Pre-flight checklist (before running DDL in production)

Until Gates R0-R4 are automated, here's what should be checked manually — ready to copy and run:

```sql
-- 1. Confirm you're connected to the expected database
SELECT DATABASE();

-- 2. Are there long-running transactions that haven't committed
SELECT trx_id, trx_mysql_thread_id,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec,
       trx_rows_modified, trx_query
FROM information_schema.INNODB_TRX
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 5
ORDER BY duration_sec DESC;

-- 3. Are there any connections currently waiting on an MDL
SELECT id, user, host, time, state, info
FROM information_schema.PROCESSLIST
WHERE state LIKE '%metadata lock%' OR state LIKE '%Waiting for table%';

-- 4. Is this connection a read-only replica (if so, any write will fail — confirm you're on the right node first)
SELECT @@global.read_only, @@global.innodb_read_only;

-- 5. (Only needed for large-table ALTERs) Check table size to decide whether to use pt-online-schema-change
SELECT table_name, table_rows,
       ROUND(data_length/1024/1024, 1) AS data_mb
FROM information_schema.TABLES
WHERE table_schema = DATABASE() AND table_name = '<table to change>';
```

**Criteria**: it's safe to proceed only if both queries 2 and 3 return empty results. If query 4 returns `1`, stop and connect to the correct node instead. For query 5, if the table is large and you're doing `MODIFY/CHANGE COLUMN`/`ENGINE=`, use pt-online-schema-change instead (see link below) rather than running it directly.

Also re-run `node src/cli.js validate -c <config>` to confirm there are no un-allowed 🔴/🟠 operations, and no unexpected `ALTER_TABLE_MODIFY`/`ALTER_TABLE_REBUILD` warnings.

---

## 6. Protection during execution

MariaDB DDL projects have Lock Guard enabled by default: before each migration SQL statement runs, the connection sets a short timeout first (default 5-second `lock_wait_timeout`); if it hits a lock, it retries up to 3 times with a 2-second interval, and only reports a real error once all retries are exhausted — it will not queue indefinitely and drag down other queries. For details, config options, and the question of whether a DDL statement that's just naturally slow could be misclassified as a failure, see [LOCK-GUARD.md](./LOCK-GUARD.md).

---

## 7. Abort / rollback procedure after the fact

### 7.1 Automatic layer (existing mechanism)

When `up --sanity-check` runs, if the migration file has a `PostCheck` defined, a failure automatically triggers a `down()` rollback:

- Rollback succeeds → reports the failure reason; the database returns to its pre-execution state.
- **Rollback also fails** → marked as `critical`; the tool explicitly prints that "manual intervention is required." In this case, **do not** rerun any command against the same connection — manually confirm the database's actual state first.

- A migration that **fails partway** (no sanity check involved) is not undone by either database — MariaDB commits each DDL statement immediately, and MongoDB migrations aren't transactional. It's not recorded as applied, and both the console and the failure notification email now say so explicitly. Check what it already did before running again — [§7.4](#74-a-migration-failed-partway-recovering).
- When the stop was refused *before* execution (validation, checksum, changelog consistency, missing database), nothing ran — the email says "nothing was applied" and has no partial-apply warning.

### Rolling back with `down`

`down` prints exactly which migrations it will roll back (most recent first) and asks you to type `yes`; in a pipeline (no terminal) it refuses unless `--yes` is passed. Use `down --dry-run` (with `-n` or `--target`) to see the plan without touching anything. It also refuses if any file in the plan was edited after being applied — the Down section that would run isn't the one that was applied with — unless `--allow-checksum-drift`.

`down` only rolls back migrations recorded as applied. Right after a failure, `down -n 1` therefore rolls back the most recent **successful** migration, not the one that failed — see [§7.4](#74-a-migration-failed-partway-recovering).

### 7.2 Manually aborting a stuck migration

1. First figure out **who** is stuck: use queries 2 and 3 from Section 5 to find the long transaction or the session waiting on the lock.
2. **Prefer killing the blocking transaction** (if it's a batch job that can safely be rerun) **rather than killing the migration itself** — force-interrupting the migration is likely to land you in the 1.8 "SQL ran, changelog didn't get written" partial state.
   ```sql
   KILL <thread_id>;  -- matches the trx_mysql_thread_id / id found via queries 2, 3 in Section 5
   ```
3. If you truly must abort the migration itself (e.g., it's stuck by itself, or it was a misjudgment — for one that is simply running too long, see [§7.5](#75-a-migration-is-running-too-long-in-production)), **check the actual DB state first** after interrupting, before deciding what to do next:
   ```bash
   node src/cli.js status -c <config>
   ```
   If the status shows pending but you suspect the SQL actually already ran (check `information_schema` to confirm whether the expected tables/columns already exist), **do not** just rerun `up` — manually verify first, and if needed use `baseline` to manually mark it as applied, or fix the migration to be idempotent before rerunning.

### 7.3 The blocker is someone else (not the migration itself)

If a different application's long transaction is blocking the migration (the exact scenario that originated this handbook):

- Find the source of that transaction (`trx_query`, `host`), and evaluate whether that team can commit/rollback it rather than killing someone else's transaction directly — unless you've already confirmed it's a batch job that's safe to interrupt.
- Batch jobs (large DELETE/UPDATE) should commit in batches and set a reasonable `innodb_lock_wait_timeout` themselves — that's the responsibility of the application team, not something db-migrate controls, but it's worth raising with that team after an incident like this.

### 7.4 A migration failed partway: recovering

The short version: **don't run `down`. Find out how far it got, remove the cause, and re-run a migration that is safe to re-run.**

#### What is and isn't all-or-nothing

Checked against real servers (MariaDB 11.8 with InnoDB, MongoDB 7, 200,000 rows / documents, failure forced at row 150,000):

| Unit | MariaDB (InnoDB) | MongoDB |
|---|---|---|
| **One DDL statement / command** | All or nothing. One `ALTER TABLE … ADD COLUMN extra INT, ADD UNIQUE INDEX uq_d (d)` hitting a duplicate left neither the column nor the index. | All or nothing. One `createIndexes` building two indexes, the second hitting a duplicate, left neither. An index build stopped by `ddlSafety.operationTimeoutMs` was dropped by the server. |
| **One DML statement / operation** | All or nothing. An `UPDATE` over 200,000 rows that failed at row 150,000 changed **0** rows. | **Not.** An `updateMany` that failed at document 150,000 left **149,999** documents changed. The same applies to `deleteMany`, `insertMany` and `bulkWrite`, whatever stops them: bad data, a lost connection, a primary step-down, or `operationTimeoutMs` (a 300 ms limit stopped an 11 s `updateMany` after 24,179 of 1,000,000 documents). |
| **A migration with several statements / operations** | **Not.** Each statement commits on its own, so the ones before the failure stay applied. | **Not.** Operations before the failing one stay applied. |

- MariaDB's DDL stays all-or-nothing even if the server crashes or the statement is killed only from 10.6, and only for InnoDB. That case wasn't tested here.
- In MongoDB, many "schema changes" are really data changes: back-filling a new field (`updateMany … $set`) or renaming one (`$rename`) can stop halfway. Real schema operations are single commands and are all-or-nothing: `createCollection`, `createIndex`, `dropIndex`, `collMod`, `renameCollection`.
- In a multi-statement MariaDB migration, the error says how far it got, e.g. `… (statement 3 of 3; statements 1–2 were already applied — …)`. A MongoDB error doesn't, because the migration is JavaScript: check the data.

#### Why not `down`

- **The tool never runs Down for a failed migration.** It stops, reports the error, and doesn't record the migration as applied. The only automatic Down is §7.1's: with `--sanity-check`, when Up **completed** but its PostCheck failed.
- **Down is written for a fully applied Up.** On a partly applied one it usually fails on the first object that was never created (`DROP COLUMN` of a column that isn't there), leaving things messier.
- **`down -n 1` right after a failure rolls back the wrong migration.** The failed one isn't recorded as applied, so `down` takes the most recent *successful* migration.

#### Recovering

1. **Read the error.** Which statement failed, what was already applied, and why.
2. **Remove the cause:** duplicate data, a long transaction holding the table (§7.3), a syntax error, a missing privilege. Otherwise the re-run fails at the same place. (A lock-wait timeout that clears within the retry window was already retried for that statement by Lock Guard.)
3. **A single-statement migration failed** → it's all-or-nothing, so nothing changed. Re-run it as is.
4. **A multi-statement migration stopped partway.** First decide whether the file was **already applied successfully in another environment** (e.g. it passed in staging and failed in production):
   - **Not applied anywhere** → make Up safe to re-run, update Down to match, add a PreCheck and a PostCheck (below), and re-run. Editing it is fine: the checksum gate only covers applied migrations.
   - **Applied somewhere else** → **don't edit the file.** Its checksum changes, and the next run in that environment refuses because an applied file was edited (unless `--allow-checksum-drift`). Instead, in the failed environment either:
     - finish the remaining statements by hand, check the result, and mark the migration applied with `baseline --file <file>`; or
     - undo the statements that were applied, then re-run the unchanged file.
5. **Check.** `status` shows it applied, and the PostCheck passed (run with `--sanity-check`).

#### Writing Up so it can be re-run

**MariaDB:**

```sql
-- +sanity PreCheck
-- preconditions, not "not applied yet": a re-run must pass this too.
-- If note_count already exists it must already be what this migration adds —
-- otherwise stop before anything runs (IF NOT EXISTS below would skip it silently)
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'note_count' AND COLUMN_TYPE <> 'int(11)'
-- END_CHECK

-- +migrate Up
CREATE TABLE IF NOT EXISTS order_notes (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  note TEXT
);
-- several changes to one table: one ALTER, so they're all-or-nothing together
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS note_count INT NOT NULL DEFAULT 0,
  ADD INDEX IF NOT EXISTS idx_orders_note_count (note_count);

-- +sanity PostCheck
-- check the end state
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'note_count' AND COLUMN_TYPE = 'int(11)'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_note_count'
-- END_CHECK

-- +migrate Down
ALTER TABLE orders DROP INDEX IF EXISTS idx_orders_note_count, DROP COLUMN IF EXISTS note_count;
DROP TABLE IF EXISTS order_notes;
```

**MongoDB** (data changes must *resume*, not *redo*):

```javascript
export async function up(db) {
  // createIndex with the same keys and options is a no-op when the index exists
  await db.collection('orders').createIndex({ customerId: 1 }, { name: 'idx_customer' });
  // only documents not done yet — a re-run picks up where the last one stopped
  await db.collection('orders').updateMany(
    { noteCount: { $exists: false } },
    { $set: { noteCount: 0 } }
  );
}
```

Avoid updates that change the result when repeated, such as `$inc`, `$push` or `insertMany` of fixed documents. If one is unavoidable, record which documents were already processed (a marker field) and filter on it.

#### Things to watch

- **`IF NOT EXISTS` skips silently.** It's right for objects this migration created on the failed run: their definition is exactly what's in the file. But an object with the same name created some other way, with a different definition, is skipped too, and nothing is reported. Catch that in the **PreCheck**, before anything runs ("if it exists, it must already be right", as above). Leaving it to the PostCheck is too late: a failed PostCheck triggers the automatic rollback, and a Down written with `IF EXISTS` then drops that pre-existing object too — tested: a `VARCHAR` column `note_count` that existed before the migration was dropped by the rollback. Sanity checks run only with `--sanity-check` (in `k8s/dynamic/`, put it in `ddl.args`).
- **A PreCheck that asserts "not applied yet"** (e.g. `EXPECT_NO_ROWS` on the new column) fails the re-run once a partial run added that column. Check preconditions instead (the table exists; anything already there has the right definition).
- **MySQL 8 has `IF [NOT] EXISTS` only on `CREATE TABLE` / `DROP TABLE`** — not on `ADD COLUMN`, `ADD INDEX`, `CREATE INDEX`, `DROP COLUMN` or `DROP INDEX` (all rejected by MySQL 8.4, all accepted by MariaDB). On MySQL, keep each migration to one statement (all-or-nothing, so a failure leaves nothing to clean up), or put same-table changes in one `ALTER`.
- **Keep Down in step with Up.** Use `IF EXISTS` (`DROP COLUMN IF EXISTS`, `DROP INDEX IF EXISTS`, `DROP TABLE IF EXISTS`), so rolling back after a partial run works too.
- **Don't add an automatic re-run.** Transient lock waits are already retried per statement by Lock Guard. Other failures (duplicate data, syntax, privileges) fail the same way every time, and re-running a MongoDB data change that keeps failing only adds to what it left behind. Re-run once someone has looked at the cause.

Writing every migration this way from the start (re-runnable, same-table changes in one `ALTER`, a PreCheck on preconditions and a PostCheck on the end state) means a failure needs no file edit: remove the cause and re-run.

### 7.5 A migration is running too long in production

Stop it on the server with `KILL QUERY` — **not** by killing the Pod, deleting the Job, pressing Ctrl-C or waiting for `activeDeadlineSeconds`. Those stop the client only: MariaDB keeps running the statement and commits it.

Measured on MariaDB 11.8 with a 4,000,000-row InnoDB table (2026-10-07):

| What was done | What happened to the statement | Table afterwards |
|---|---|---|
| `KILL QUERY` on a COPY `ALTER … MODIFY` | gone ~1 s later, errno 1317 to the client | unchanged; no `#sql…` temp table left |
| 3 s `max_statement_time` on a COPY `ALTER` | stopped at 3.2 s, errno 1969 | unchanged |
| 3 s `max_statement_time` on an in-place `ADD INDEX` | stopped at 3.2 s, errno 1317 | no index |
| 3 s `max_statement_time` on `UPDATE` of every row | stopped, then rolled back — 6.7 s in all | unchanged (`SUM` identical) |
| Client process killed 3 s into a COPY `ALTER` | **kept running**, finished ~40 s later | **altered** (`INT` → `BIGINT`), migration not recorded |

1. Find the statement:
   ```sql
   SELECT ID, USER, TIME, STATE, LEFT(INFO, 120) AS query
     FROM information_schema.PROCESSLIST
    WHERE DB = '<database>' AND COMMAND = 'Query' AND ID <> CONNECTION_ID()
    ORDER BY TIME DESC;
   ```
   `copy to tmp table` in `STATE` is a COPY `ALTER`: writes to that table are blocked until it ends.
2. Decide whether stopping is cheaper than waiting. An `ALTER` stops almost at once. An `UPDATE` / `DELETE` has to roll back what it already changed, which takes about as long as it has run — near the end, letting it finish is usually quicker.
3. Stop it:
   ```sql
   KILL QUERY <ID>;
   ```
   The tool receives the error, reports which statement of the file stopped (X3 in [EXECUTION-FLOW.md](EXECUTION-FLOW.md)), doesn't record the migration and runs nothing after it. Statements before it in the same file stay applied — recover per [§7.4](#74-a-migration-failed-partway-recovering).

**If the client was already killed** (Pod deadline, Job deleted): the statement is still running or already committed. Watch `PROCESSLIST` until it's gone, check the table, then either `baseline --file <file>` (the whole file is now applied) or finish / undo it by hand per §7.4 — re-running `up` would repeat statements that already ran.

**Next time, before it starts:** R4 warns about an `ALTER`, index build or bulk `UPDATE`/`DELETE` on a table of `runtimeGates.largeTableRows` (1,000,000) rows or more; `ddlSafety.statementTimeoutSec`, or `-- @statement-timeout-sec: N` in the file, makes the server stop and roll back any statement running longer ([RUNTIME-GATE-PLAN.md, R5](RUNTIME-GATE-PLAN.md)); for a large COPY `ALTER`, use pt-online-schema-change.

---

## 8. How do we know these protections actually work (current validation status)

An honest account of the current level of validation (updated 2026-10-02). "CI" means it runs on every push to `main` (`.github/workflows/migrations.yml`):

| Item | Validation method | Status |
|---|---|---|
| Lock Guard's code logic | Mocked unit tests | ✅ CI |
| Lock Guard against a real MariaDB (bounded wait, retry, no queue jam) | `test/integration.test.js` scenarios 1–3 | ✅ CI, real MariaDB |
| Validation rules, tiers and allowances | Unit tests + `test-all` running every fixture with `@expect-error` expectations | ✅ CI |
| The two FK / orphan-drop logic bugs ([Bug A / Bug B](VALIDATION-RULES-MARIADB.md)) | Unit tests | ✅ Fixed (2026-09-29) |
| Sanity-check rollback actually restoring the schema | `test-all --sanity-check` with fixtures whose Post-Check fails by design | ✅ CI, real MariaDB and MongoDB |
| Runtime gates R0–R4 | Unit tests; R2 against a real open transaction in `test/integration.test.js` scenario 4; all gates run in every real-server test, and a missing privilege was confirmed to be reported as skipped (or refused with `requireLockCheck`) | ✅ CI for R0–R2 · ⚠️ R3 refusing a read-only target has not been exercised against a real replica |
| MySQL 8 (the tool's own SQL) | `test/mysql-compat.test.js` — the CLI against MySQL 8.4, including upgrading old bookkeeping tables | ✅ CI, real MySQL |
| `reset` command | Mocked unit tests | ⚠️ Not run against a real database in CI |

What CI can't cover — production-sized tables, real replication topologies, your migrations' own SQL — still needs a staging run before production.

---

## Related document index

- [Lock Conflict Defense Map](https://claude.ai/code/artifact/58c23985-91d9-45dd-a137-93819f6f940f) (Artifact) — timeline diagrams of the four lock conflict scenarios
- [LOCK-GUARD.md](./LOCK-GUARD.md) — full Lock Guard spec
- [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md) — full design of Gates R0-R6
- [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md) / [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) — detailed validation rule tables
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) — test coverage and known gaps
- [CLI-USAGE-GUIDE.md](./CLI-USAGE-GUIDE.md) — operational details for `reset`, `baseline`, and other commands
