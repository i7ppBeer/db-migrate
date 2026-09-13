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

**Mitigation**: write UP blocks to be idempotent wherever possible (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, or check `information_schema` first before deciding whether to run), so a re-run won't error out.

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
| Tiered static validation (🔴 forbidden / 🟠 dangerous / 🟡 warning) + annotations | 1.5 (mixing DDL/DCL), unintentional dangerous operations | ✅ Live | [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md), [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) |
| Lock Guard (session `lock_wait_timeout` + bounded retries) | 1.1, 1.2 (doesn't change execution time, only changes lock-wait time) | ✅ Live (`feat/mariadb-lock-guard`) | [LOCK-GUARD.md](./LOCK-GUARD.md) |
| Sanity Check Pre/PostCheck + Auto-Rollback | Validates the result after execution against expectations, auto-rolls back if it doesn't match | ✅ Live (existing mechanism) | `src/core/sanity-checker.js` |
| `reset` command | One remediation option for 1.7 (paired with a full environment reset) | ✅ Live | See Section 2 |
| `validate` command's `[FORCE ALLOWED]`/`[ALLOWED]` audit trail | Every dangerous operation that gets allowed through leaves an audit record instead of passing silently | ✅ Live | Same validation rule docs as above |

**This audit also found two existing logic bugs** (which misclassify legitimate migrations as errors) — related to this handbook's theme but the opposite problem: not "a dangerous operation slipping through" but "a safe operation being wrongly blocked." Details in [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md#confirmed-logic-bugs-traced-by-hand-not-inspection-guesses).

---

## 4. Protections not yet built (in design)

Full spec is in [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md); this is just the summary:

| Gate | Checks | Addresses | `--force`-able? |
|---|---|---|---|
| R0 Connection identity | Does the connection actually point at the database the config says it should? | 1.6 | ❌ No |
| R1 changelog consistency | Does the changelog/checksum match the files on disk? | 1.7 | ❌ No |
| R2 Long transactions / lock waits | Are there already stuck transactions or MDL waits before execution? | 1.1 | ✅ Yes |
| R3 Writability / replica check | Is the target a read-only replica? | Variant of 1.6 | Read-only → ❌; lagging → ✅ |
| R4 Disk/binlog space | Could a large ALTER exhaust available space? | 1.2 | ✅ Yes |

R0/R1 deliberately have no override option — connecting to the wrong database or a mismatched changelog is a "someone needs to go look at this" situation, not a "skip it if the risk is acceptable" situation.

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

### 7.2 Manually aborting a stuck migration

1. First figure out **who** is stuck: use queries 2 and 3 from Section 5 to find the long transaction or the session waiting on the lock.
2. **Prefer killing the blocking transaction** (if it's a batch job that can safely be rerun) **rather than killing the migration itself** — force-interrupting the migration is likely to land you in the 1.8 "SQL ran, changelog didn't get written" partial state.
   ```sql
   KILL <thread_id>;  -- matches the trx_mysql_thread_id / id found via queries 2, 3 in Section 5
   ```
3. If you truly must abort the migration itself (e.g., it's stuck by itself, or it was a misjudgment), **check the actual DB state first** after interrupting, before deciding what to do next:
   ```bash
   node src/cli.js status -c <config>
   ```
   If the status shows pending but you suspect the SQL actually already ran (check `information_schema` to confirm whether the expected tables/columns already exist), **do not** just rerun `up` — manually verify first, and if needed use `baseline` to manually mark it as applied, or fix the migration to be idempotent before rerunning.

### 7.3 The blocker is someone else (not the migration itself)

If a different application's long transaction is blocking the migration (the exact scenario that originated this handbook):

- Find the source of that transaction (`trx_query`, `host`), and evaluate whether that team can commit/rollback it rather than killing someone else's transaction directly — unless you've already confirmed it's a batch job that's safe to interrupt.
- Batch jobs (large DELETE/UPDATE) should commit in batches and set a reasonable `innodb_lock_wait_timeout` themselves — that's the responsibility of the application team, not something db-migrate controls, but it's worth raising with that team after an incident like this.

---

## 8. How do we know these protections actually work (current validation status)

An honest account of the current level of validation — don't take any of it at face value:

| Item | Validation method | Status |
|---|---|---|
| Lock Guard's code logic | Line-by-line source review + 6 mocked unit tests | ✅ Validated |
| Lock Guard's behavior against real MariaDB (3 e2e scenarios) | `test/integration.test.js`, logic reviewed | ⚠️ Not actually run yet (no Docker/MariaDB in this environment) |
| Validation rule tiering/annotation mechanism | Line-by-line source review + actual CLI execution screenshots | ✅ Validated |
| The two FK / orphan-drop logic bugs | Manual step-through + concrete SQL counterexamples | ✅ Confirmed real bugs, not yet fixed |
| Runtime Gate R0-R4 | Design document only | ❌ Not implemented at all, cannot be validated |
| `reset` command | 13 mocked unit tests | ✅ Logic validated; not tested against a real DB |

For the full list of test gaps, see the "Known test gaps" section in [TESTING-GUIDE.md](./TESTING-GUIDE.md#known-test-gaps-audited-2026-09-10).

---

## Related document index

- [Lock Conflict Defense Map](https://claude.ai/code/artifact/58c23985-91d9-45dd-a137-93819f6f940f) (Artifact) — timeline diagrams of the four lock conflict scenarios
- [LOCK-GUARD.md](./LOCK-GUARD.md) — full Lock Guard spec
- [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md) — full design of Gates R0-R6
- [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md) / [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) — detailed validation rule tables
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) — test coverage and known gaps
- [CLI-USAGE-GUIDE.md](./CLI-USAGE-GUIDE.md) — operational details for `reset`, `baseline`, and other commands
