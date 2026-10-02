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
- **Advisory** — overridable with an explicit flag named after what it overrides
  (`--allow-open-transactions` for R2, `--allow-checksum-drift` for R1's checksum
  check — deliberately not one blanket `--force`), because the person running
  the command may have context the tool doesn't (e.g. "yes, I know there's a long
  transaction, it's mine, I'm about to commit it"). Every advisory override is logged
  with a timestamp and the reason, if given — this is an audit trail, not a silent
  bypass.

---

## Gate R0 — Connectivity & identity (absolute) — ✅ Implemented

**When**: inside `connect()` itself, before it returns — applies to every command that
connects, not just `up`/`sync`/`dcl`.

**Checks**:
- ✅ Connection succeeds within a short timeout (`connectTimeout` / `connectTimeoutMS` +
  `serverSelectionTimeoutMS`, default 10s, configurable via `mariadb.connectTimeoutMs` /
  `mongodb.options`) — fails fast on an unreachable host rather than hanging on the
  driver's own default (MariaDB: OS TCP timeout, can be very long; MongoDB driver
  default is 30s).
- ✅ The connection actually points at the database/schema named in `config` —
  `SELECT DATABASE()` (MariaDB) or `db.databaseName` (MongoDB, no query needed — the
  driver reports it directly) compared against `config.database` /
  `config.mongodb.databaseName`. A mismatch here means an env var resolved to the wrong
  environment, which is exactly the kind of mistake that leads to running a migration
  meant for staging against production.
- ✅ The database **exists**. Before this check, `connect()` ran `CREATE DATABASE IF NOT
  EXISTS` (MariaDB) and MongoDB creates a database on first write — so a typo'd name or
  wrong environment got a brand-new empty database, every migration was applied to it,
  and the identity check above could never fail. Now a missing database is an error
  unless the config sets `createDatabaseIfMissing: true` (new environments, local/test
  fixtures). MariaDB checks `information_schema.SCHEMATA`; MongoDB checks
  `listDatabases({ nameOnly, authorizedDatabases })` for versioned runs and only warns
  if the account isn't allowed to list databases.
- ✅ Credentials are configured. MariaDB no longer falls back to `root`/`rootpass` when
  `user`/`password` (or `MARIADB_USER`/`MARIADB_PASSWORD`) are missing — it stops.

**On failure**: abort immediately (connection is closed first), print which database
was expected vs. actually connected (or that it doesn't exist), exit non-zero. No `--force` — see
`connect()` in both `src/adapters/mariadb-adapter.js` and `mongodb-adapter.js`, and
`test/mariadb-adapter.test.js` / `test/mongodb-adapter.test.js`'s `describe('connect()
— Gate R0 identity check', ...)` blocks.

---

## Gate R1 — Changelog / baseline consistency (absolute) — ✅ Implemented for DDL

**When**: `status()` computes all of this every time it runs; `up`/`sync` enforce it
(via `enforceChangelogConsistencyGate()` + `enforceChecksumGate()` in `src/cli.js`)
right after connecting, before computing/applying anything. `status` itself only
displays it — it never blocks, being a read-only diagnostic.

**Checks (DDL)** — all three implemented, both adapters:
- ✅ **Checksum content check**. The changelog stores a SHA-256 checksum of each
  migration file's content alongside `id`/`applied_at` (self-healing `ALTER TABLE ADD
  COLUMN IF NOT EXISTS` for MariaDB tables created before this existed). `status()`
  recomputes every applied file's current checksum and compares it against what was
  stored at apply time. A mismatch means the file was edited after being applied —
  `up`/`sync` refuse to proceed past it; `--allow-checksum-drift` is the explicit,
  logged override (it also updates the stored checksum, so the same accepted drift
  doesn't re-trigger next run). A row with no stored checksum at all (upgraded from
  before this existed) adopts the current file as its baseline rather than erroring.
  See docs/DDL-PRODUCTION-SAFETY.md §3.
- ✅ **Orphaned changelog entries**. Every row in the changelog is checked against the
  files actually in `migrationsDir` — `status().orphanedChangelogEntries` lists any row
  with no matching file (deleted or renamed after being applied, or `migrationsDir`
  pointing at the wrong place). **No override** — `up`/`sync` refuse unconditionally.
- ✅ **Out-of-order applied migrations**. Applied migrations should form a contiguous
  prefix of the sorted file list — `status().outOfOrderApplied` lists any applied file
  that sorts *after* a still-pending one (a sign of out-of-order application or a
  rename after the fact). **No override** — same as above.
- Changelog table exists and is readable (it self-heals via `CREATE TABLE IF NOT
  EXISTS` already — this gate is about what's *in* it, not whether it exists).

**Checks (DCL)**: ✅ implemented (2026-10-01) — a stored checksum for a file that no
longer exists on disk is flagged (same "file deleted after being applied" concern):
`dcl:status` lists it, `dcl`/`dcl-all` refuse until the file is restored or
`--accept-removed-dcl` confirms the removal (which forgets the checksum record, logged;
accounts are untouched). Unlike DDL there is an override, because retiring a DCL
script is a legitimate thing to do. (Content drift isn't a DCL concern — DCL re-runs
on checksum change by design; that's the whole "repeatable" model.)

**On failure**: orphaned-entry/out-of-order failures abort with a report of the
specific offending rows/files, exit non-zero, **no `--force`** — "someone should look
at this by hand," not "proceed anyway." The checksum-content check takes a different
stance (see above) because unlike a missing file or reordered history, "this file's
content changed" has a legitimate, common cause: someone intentionally fixed a comment
or typo in an already-applied file.

---

## Gate R2 — Long-transaction / lock contention preflight (advisory) — ✅ Implemented

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
refuse to proceed, require `--allow-open-transactions` to continue anyway (the override
is printed with a timestamp). This is exactly what would have caught the 2026-09-10
incident before it happened — a stale DELETE transaction holding the table this
migration's `ALTER` needed.

**As implemented** (`runtimePreflight()` in both adapters, `enforceRuntimeGates()` in
`src/cli.js`): runs in `up`, `sync`, `up-all` and `down`, right before execution
(`--dry-run` reports what it would refuse). Threshold `runtimeGates.longTransactionSec`
(default 60). MariaDB looks only at sessions whose current database is the migration's
own (or none) and skips its own connection — a long transaction in another schema on a
shared server can't hold this schema's tables; MongoDB looks at operations on this
database (`ns`) plus any multi-document transaction open that long. Needs the `PROCESS`
privilege (MariaDB) / `inprog` (MongoDB, e.g. `clusterMonitor`); without it the check is
reported as **skipped**, not passed, and the run continues. MariaDB without `PROCESS`
may also see only its own sessions in `PROCESSLIST`.

**Found while building this**: the tool's own startup could get stuck in exactly this
situation. `ensureChangelogTable()` ran `CREATE DATABASE IF NOT EXISTS` on every connect
and `status()`, and that statement requests an *exclusive* schema metadata lock even
when the database exists — so with a long transaction open and an `ALTER` queued, `sync`
waited behind them (MariaDB's default `lock_wait_timeout` is a year) before R2 could
even run, and became one more waiter everything else queued behind. Fixed: the
database is created only when it's actually missing (and `createDatabaseIfMissing`
allows it), and the tool's own session uses the Lock Guard's `lock_wait_timeout`.
Covered by Scenario 4 of `test/integration.test.js`, which CI runs against a real MariaDB.

---

## Gate R3 — Writability / replica-target check (absolute for read-only, advisory for lag) — ✅ Implemented

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

**As implemented**: runs for every writing command — `up`, `sync`, `up-all`, `down`,
`dcl`, `dcl-all`. The MariaDB check refuses on `read_only`/`innodb_read_only`
**regardless of the account's privileges**: a `SUPER`/`READ_ONLY ADMIN` account can
still write to a read-only server, which on a replica only makes it diverge. Lag
threshold: `runtimeGates.replicationLagWarnSec` (default 30).

---

## Gate R4 — Disk / binlog headroom (advisory, best-effort) — ✅ Implemented

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

**As implemented**: MariaDB — total `SHOW BINARY LOGS` size over
`runtimeGates.binlogWarnMb` (default 10240); "binary logging is off" or a missing
privilege is reported as skipped. MariaDB has no SQL view of free disk space, so this is
the only headroom signal. MongoDB — filesystem usage from `dbStats`
(`fsUsedSize`/`fsTotalSize`) over `runtimeGates.diskUsageWarnPercent` (default 90).
Runs with R2 (DDL commands only).

```javascript
// config.js — all optional
runtimeGates: { longTransactionSec: 60, replicationLagWarnSec: 30, binlogWarnMb: 10240, diskUsageWarnPercent: 90 }
```

---

## Gate R5 — Session lock guard (advisory, execution-time) — ✅ Implemented (MongoDB: opt-in)

Already specified in the Lock Guard plan (`feat/mariadb-lock-guard`): `SET SESSION
lock_wait_timeout` / `innodb_lock_wait_timeout` + bounded retry around each executed
statement, so a lock acquired *during* execution (not caught by Gate R2's snapshot,
because timing) still fails fast instead of queuing forever and dragging every
subsequent query down with it.

MongoDB equivalent: `maxTimeMS` on the operations the migration issues, so a write
blocked behind another long-held lock also fails fast rather than hanging the whole
migration run.

**MongoDB — implemented as `ddlSafety.operationTimeoutMs` (off by default).** When set,
the `db` and `client` a migration's `up()`/`down()` receive carry the driver's
`timeoutMS` (client-side operation timeout, which also sends `maxTimeMS` to the
server), so **each operation** issued through them — including through
`client.db('other')` — is stopped once it runs longer than the limit. The run fails
with an error that names the setting:

```
An operation ran longer than ddlSafety.operationTimeoutMs (2000 ms) and was stopped (…).
If this migration is expected to be slow (e.g. a large index build), raise the limit for it or run it off-peak.
```

```javascript
// config.js (MongoDB DDL)
ddlSafety: { operationTimeoutMs: 60000 }
```

Off by default because a sensible limit depends on the data: a legitimate index build
on a large collection can take minutes. It bounds single operations, not the whole
migration — many fast operations never trip it. Verified against a real MongoDB 7: a
migration whose query takes ~10 s server-side stopped after 2.5 s with a 2000 ms limit,
and ran its full 10.9 s without one. As with any failed MongoDB migration, operations
before the one that timed out are not undone.

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

**R0, R1 (DDL and DCL), R2, R3 and R4 are live** (2026-10-01). R5 is live for MariaDB as the Lock Guard,
and for MongoDB as the opt-in `ddlSafety.operationTimeoutMs` (2026-10-02); R6 already existed before this plan. Recommended build
order for what's left: DCL's side of R1 next (same shape as the DDL work, smaller),
then R2/R3 (the actual incident-prevention value against real lock contention/replica
state), R4 last (lowest value, needs a privilege the connecting user may not have).

Needs the same thing Lock Guard's e2e suite needs: a reachable MariaDB/MongoDB to
verify against — R0 and R1 above were both verified with mocked connections
(`test/mariadb-adapter.test.js`, `test/mongodb-adapter.test.js`), not a real database,
for the same reason. Test plan once a real DB is available: deliberately misconfigure
`config.database` and confirm `connect()` actually refuses (R0); delete an applied
migration file and confirm `status`/`up`/`sync` flag it as orphaned; apply migrations
out of order (e.g. via direct changelog manipulation) and confirm the out-of-order
check catches it; edit an already-applied file's content and confirm `up`/`sync`
refuse to proceed (checksum part of R1); hold a transaction open (R2); point at a
read-only replica if one is available (R3).
