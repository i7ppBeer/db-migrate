# Runtime Readiness Gate Plan

Answers one question: **before this tool touches a real database, how does it know
the database is actually in a state where that's safe — and if it isn't, how does it
refuse instead of doing something wrong?**

This extends the Lock Guard plan from the `feat/mariadb-lock-guard` branch (MDL queue
contention specifically) into the general case: connectivity, identity, changelog
consistency, replica/read-only state, and lock contention are all "is now a good time"
questions that should be answered **before** `up()`/`down()`/`dcl` starts mutating
anything — not discovered midway through as a cryptic driver error.

Applies to both DDL (`up`/`down`) and DCL (`dcl`) execution paths, both adapters. Not
all gates apply to both — noted per gate.

## Design rule: absolute gates vs. advisory gates

Every gate below is one of two kinds, and this distinction is deliberate:

- **Absolute** — never overridable by a flag. If it fails, something is structurally
  wrong (wrong database, corrupted changelog, read-only target) and proceeding would
  be actively harmful, not just risky. No `--force` exists for these.
- **Advisory** — overridable with an explicit `--force`, because the person running
  the command may have context the tool doesn't (e.g. "yes, I know there's a long
  transaction, it's mine, I'm about to commit it"). Every advisory override is logged
  with a timestamp and the reason, if given — this is an audit trail, not a silent
  bypass.

---

## Gate R0 — Connectivity & identity (absolute)

**When**: immediately after `connect()`, before anything else.

**Checks**:
- Connection succeeds within a short timeout (fail fast on an unreachable host rather
  than hanging on the driver's own default — which can be very long).
- The connection actually points at the database/schema named in `config` — query
  `SELECT DATABASE()` (MariaDB) or `db.databaseName` (MongoDB) and compare against
  `config.database` / `config.mongodb.databaseName`. A mismatch here means an env var
  resolved to the wrong environment, which is exactly the kind of mistake that leads
  to running a migration meant for staging against production.

**On failure**: abort immediately, print which database was expected vs. actually
connected, exit non-zero. No `--force`.

---

## Gate R1 — Changelog / baseline consistency (absolute)

**When**: right after Gate R0, before computing the pending-migration list.

**Checks (DDL)**:
- Changelog table exists and is readable (it self-heals via `CREATE TABLE IF NOT
  EXISTS` already — this gate is about what's *in* it, not whether it exists).
- Every row in the changelog corresponds to a migration file still present in
  `migrationsDir`. A changelog entry with no matching file means either a file was
  deleted after being applied (in which case `down()` can never run it) or the
  changelog points at the wrong `migrationsDir` entirely.
- Applied migrations form a contiguous prefix of the sorted file list — a "pending"
  migration that sorts *before* an already-applied one is a sign migrations were
  applied out of order or a file was renamed after being applied.

**Checks (DCL)**: checksum table readable; a stored checksum for a file that no longer
exists on disk is flagged (same "file deleted after being applied" concern).

**On failure**: abort with a diff-style report (`expected N applied, found M on disk`,
listing the specific mismatched filenames), exit non-zero. No `--force` — this is a
"someone should look at this by hand" situation, not a "proceed anyway" situation.

---

## Gate R2 — Long-transaction / lock contention preflight (advisory)

**When**: right before `up()`/`down()`/`dcl` starts executing migration SQL.

**Checks (MariaDB)**:
```sql
SELECT trx_id, trx_mysql_thread_id,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec, trx_query
FROM information_schema.INNODB_TRX
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > <threshold_sec>;

SELECT id, user, host, time, state, info
FROM information_schema.PROCESSLIST
WHERE state LIKE '%metadata lock%' OR state LIKE '%Waiting for table%';
```

**Checks (MongoDB)**:
```javascript
db.currentOp({ "secs_running": { $gt: thresholdSec }, "active": true })
```
looking for long-running write ops or open multi-document transactions
(`db.currentOp({ "transaction": { $exists: true } })`) against collections this
migration will touch.

**On failure**: print what was found (thread/op id, duration, truncated query text),
refuse to proceed, require `--force` to continue anyway. This is exactly what would
have caught the 2026-09-10 incident before it happened — a stale DELETE transaction
holding the table this migration's `ALTER` needed.

---

## Gate R3 — Writability / replica-target check (absolute for read-only, advisory for lag)

**When**: with Gate R2, right before execution.

**Checks (MariaDB)**:
```sql
SELECT @@global.read_only, @@global.innodb_read_only;
```
If either is `1` and the operation being attempted is a write/DDL, abort — the
alternative is a confusing "table is read-only" error mid-migration, sometimes after
a partial multi-statement file has already run some of its statements.

**Checks (MongoDB)**:
```javascript
db.hello().isWritablePrimary   // or db.isMaster().ismaster on older servers
rs.status()                     // member states, replication lag per secondary
```
`isWritablePrimary: false` is absolute (this connection cannot write, full stop).
Replication lag on secondaries above a threshold is advisory — informational, since it
doesn't block the primary write, but it tells the operator how far behind reads will
be immediately after this migration.

**On failure**: read-only target → abort, no `--force` (retrying against a read-only
node just fails again — the actual fix is connecting to the right node). Replication
lag → advisory warning only, proceeds by default.

---

## Gate R4 — Disk / binlog headroom (advisory, best-effort)

**When**: with Gate R2, only when the check itself is cheap and available — this gate
degrades gracefully to "skipped, could not determine" rather than blocking on missing
permissions.

**Checks (MariaDB)**: sum of `SHOW BINARY LOGS` sizes against a configured "large
migration" threshold, as an early warning specifically for the case discussed in the
Lock Guard plan (an `ALTER`/`pt-osc` run that's about to generate a lot of binlog
against a host without much headroom). Requires `REPLICATION CLIENT`/`BINLOG_MONITOR`
privilege — if the connecting user doesn't have it, this gate logs "skipped: no
permission" and does not block.

**On failure**: warning only, never blocks.

---

## Gate R5 — Session lock guard (advisory, execution-time)

Already specified in the Lock Guard plan (`feat/mariadb-lock-guard`): `SET SESSION
lock_wait_timeout` / `innodb_lock_wait_timeout` + bounded retry around each executed
statement, so a lock acquired *during* execution (not caught by Gate R2's snapshot,
because timing) still fails fast instead of queuing forever and dragging every
subsequent query down with it.

MongoDB equivalent: `maxTimeMS` on the operations the migration issues, so a write
blocked behind another long-held lock also fails fast rather than hanging the whole
migration run.

---

## Gate R6 — Post-execution sanity check (advisory, existing mechanism)

Already implemented in `src/core/sanity-checker.js` — `PreCheck`/`PostCheck` with
`autoRollback`. Not new; included here so the full gate sequence reads top-to-bottom
as one pipeline.

---

## Full sequence

```
connect() → R0 identity → R1 changelog consistency → [R2 lock preflight
  + R3 writability + R4 disk headroom, run together] → execute (R5 lock guard
  per statement) → R6 post-check → changelog write
```

R0 and R1 gate the *connection*; R2–R4 gate the *moment right before execution
starts*; R5 gates *each statement*; R6 gates the *result*.

---

## Implementation status

**Not yet implemented** — this is the design for the next phase of work after Lock
Guard (R5) ships. R6 already exists. Recommended build order: R0/R1 first (cheapest,
catches the most embarrassing class of mistake — wrong database), then R2/R3 (the
actual incident-prevention value), R4 last (lowest value, needs a privilege the
connecting user may not have).

Needs the same thing Lock Guard's e2e suite needs: a reachable MariaDB/MongoDB to
verify against, which this environment doesn't have. Test plan once available:
deliberately misconfigure `config.database` (R0), delete an applied migration file
(R1), hold a transaction open (R2), point at a read-only replica if one is available
(R3).
