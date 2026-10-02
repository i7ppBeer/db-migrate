# DB-Migrate v2.1

> Unified DDL + DCL migration tool for MongoDB and MariaDB/MySQL — versioned schema migrations, repeatable account/permission management, multi-instance rollout, and production guardrails (lock-wait protection, dangerous-operation validation, sanity checks) behind one CLI.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](package.json)

New to this tool? [QUICKSTART.md](QUICKSTART.md) is a task-oriented walkthrough ("I want to create a migration", "I want to add a DB account", …). This README is the reference: what the tool does, every command, every config shape, and where the deeper docs live.

---

## 🎯 Why this tool

Most migration tools handle schema changes (DDL) and stop there. This one also treats **account/permission management (DCL)** as a first-class, idempotent, checksum-tracked migration type — and adds the guardrails you actually want before pointing either kind at a shared or production database:

- **Two migration modes, one CLI**
  - **DDL (versioned)** — timestamp-ordered `up()`/`down()` migrations, the usual schema-change model.
  - **DCL (repeatable)** — checksum-driven `R__*` scripts for users/roles/grants. Re-runs automatically when the file changes, and is verified for idempotency before it's trusted.
- **Multi-instance** — apply the same migration set to N database instances (primary/secondary/tertiary, sharded projects, …) with one config and the `*-all` command family.
- **`sync`** — the "just make it match" command: `status` → `up` → a git-diff-style before/after schema diff → the real current schema, straight from the DB (not from the migration files). Refuses to silently no-op: it errors (non-zero exit) if nothing was pending, so a CI/CD pipeline can't mistake "nothing to do" for "it worked."
- **`dcl` shows what actually changed** — after a DCL run, it diffs before/after account and permission state (both MariaDB and MongoDB) so a reviewer sees the real effect, not just "migration applied."
- **Validation before execution** — enforced by `up`, `sync` and `up-all` themselves (not just a separate `validate` step), against exactly the migrations about to run: forbidden ops (DCL statements inside DDL), dangerous ops (`TRUNCATE`, `DROP COLUMN`, `collection.drop()`, …), empty `down()`, orphaned drops, FK integrity (MariaDB), and a SQL syntax pre-check — each with an explicit, reviewable escape hatch (`--allow`, `@allow` file annotation) rather than a silent bypass.
- **DDL checksum verification** — the changelog stores a checksum of every applied migration file's content, not just its filename. If an already-applied file gets edited afterward, `up`/`sync` refuse to proceed instead of silently trusting a file that may no longer match what actually ran — `--allow-checksum-drift` is the explicit override when the edit was intentional. See [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md).
- **Runtime gates before execution** — right before `up`/`sync`/`up-all`/`down` run anything: refuse if a long-open transaction or a queued metadata-lock wait could make the migration jam the table (`--allow-open-transactions` to override, logged), refuse a read-only target (no override — `dcl` too), and warn on low disk / large binlogs / replication lag. See [docs/RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md).
- **Lock Guard (MariaDB)** — every DDL statement runs under a bounded `lock_wait_timeout` with retry, so an `ALTER TABLE` stuck behind a long-running transaction's metadata lock fails fast instead of queuing indefinitely and jamming every later query on that table. See [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md).
- **Sanity Check** — optional Pre-Check / Post-Check assertions per migration, with auto-rollback if the post-condition doesn't hold.
- **DCL auto-generated passwords** — a `CHANGE_ME_ON_FIRST_LOGIN` placeholder in a DCL script is replaced at runtime with its own cryptographically secure, independently generated password (never printed, never written back to the file). It's never written to a bare file either — every account/permission event from a `dcl`/`sync` run (new password, rotated password, no change, account removed, permissions updated) is rendered into one mail-client-safe **run notification email** (`reports/notification.html` by default), the only place a generated password appears. See [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md).
- **Reports** — `sync`, `test-all`, and `test-instances` can all emit a JSON + HTML report via `-o <dir>`.
- **Kubernetes-ready** — example manifests in [`k8s/`](k8s/) for running `sync` as a one-shot Job, credentials from a Secret, migrations from a content-hashed ConfigMap.

---

## 📦 Installation

```bash
git clone https://github.com/your-org/db-migrate.git
cd db-migrate
npm install
```

Requires Node.js ≥ 22.12 (CI and the Docker image use Node 24 LTS; Node 20 reached end-of-life in April 2026). For local development against real databases you'll also want Docker (see below) — on Windows that means Docker Desktop with the WSL2 backend enabled (`wsl --install`, since Windows Home has no Hyper-V).

---

## 🚀 Quick Start

```bash
# 1. Start test databases
docker compose up -d mongodb mariadb

# 2. Check status, then apply
node src/cli.js status  -c test-fixtures/mariadb/test-success/ddl/config.js
node src/cli.js up      -c test-fixtures/mariadb/test-success/ddl/config.js

# 3. Validate before you trust a migration
node src/cli.js validate -c test-fixtures/mariadb/test-success/ddl/config.js

# 4. Scaffold a new one
node src/cli.js create add-users-table -c test-fixtures/mariadb/test-success/ddl/config.js

# 5. Prove it round-trips cleanly (up → down → up)
node src/cli.js test -c test-fixtures/mariadb/test-success/ddl/config.js
```

Everything above also works via `docker compose run --rm migrate <command> ...` instead of `node src/cli.js`. For a full task-by-task walkthrough (DCL account setup, multi-instance, full test cycles, MongoDB roles), see **[QUICKSTART.md](QUICKSTART.md)**.

---

## 📖 Core Concepts

### DDL vs. DCL

| | DDL (versioned) | DCL (repeatable) |
|---|---|---|
| Use for | Schema changes (tables, columns, indexes, collections) | Accounts, roles, grants, revokes |
| File naming | `<timestamp>-<name>.{sql,js}` | `R__<name>.{sql,js}` |
| Ordering | Applied in timestamp order, tracked in a changelog | Re-run whenever file checksum changes |
| Rollback | Requires `down()` | Not applicable — must be idempotent instead |
| Correctness check | Up-Down-Up test (`test`) | Idempotency check (`dcl:verify`) |

### Config Defaults & the Delta Pattern

`loadConfig()` picks a built-in defaults file from `src/config-defaults/` based on `type` + `mode` (`mariadb-ddl.js`, `mariadb-dcl.js`, `mongodb-ddl.js`, `mongodb-dcl.js`), then deep-merges your config on top. **Your `config.js` only needs to export what differs from the defaults** — host/port, lock guard tuning, etc. all fall back sensibly.

Two things deliberately have **no** fallback:

- **MariaDB credentials.** `user`/`password` come from the config or `MARIADB_USER`/`MARIADB_PASSWORD`; if neither is set, the run stops with an error instead of trying `root` with a well-known password. (Use `password: ''` explicitly for an account without one.)
- **Creating the database.** If the configured database doesn't exist, the run stops — a missing database almost always means the wrong host or a typo, and creating it would quietly apply every migration to a brand-new empty database. For a genuinely new environment (or local/test setups), set `createDatabaseIfMissing: true`. On MongoDB this is checked with `listDatabases`; an account without that right gets a warning instead of a refusal.

### Upgrading from 2.1.0

These used to be silent and now stop the run:

| Before | Now |
|---|---|
| `up`/`sync`/`up-all` ran migrations without validating them | validated first; failures refuse the whole run (use `--allow …` / `@allow` for reviewed exceptions) |
| MariaDB: a file without `-- +migrate Up` was skipped and stayed pending forever | rejected with `MISSING_UP_MARKER` |
| MariaDB: `down` silently skipped a file without a Down section | error — the migration stays applied |
| `R__` files in a DDL directory: run as versioned migrations on MongoDB, skipped on MariaDB | ignored on both (warning); old changelog entries for them are reported and left alone |
| A missing database was created automatically | error unless `createDatabaseIfMissing: true` |
| MariaDB connected as `root`/`rootpass` when nothing was configured | error |
| MongoDB `--sanity-check` ran all pending migrations in one go, skipping later files' Pre/Post-Checks | each migration runs with its own checks; `--target`/`--only` are honored |
| `--sanity-check`: after a failed check was auto-rolled back, MariaDB continued with the next migration | the run stops there (later migrations may depend on it) |
| `--target`/`--only` picked the first file whose name *contained* the value | an exact file name wins over a substring match |
| Nothing checked the database's state before executing | refuses on long-open transactions / metadata-lock waits (`--allow-open-transactions`) and on a read-only target; checks without the needed privilege are reported as skipped |
| MariaDB: every connect ran `CREATE DATABASE IF NOT EXISTS`, which waits on an exclusive schema lock — `sync` could hang behind a long transaction | only run when the database is really missing; the tool's own session waits at most the Lock Guard timeout |
| A deleted/renamed DCL script was silently ignored (its accounts stayed, untracked) | `dcl` refuses until restored or confirmed with `--accept-removed-dcl`; `dcl:status` lists it |
| Notification email always written to `notification.html` — the next run overwrote it (and any passwords in it); world-readable | each run also gets its own `notification-<runId>.html` that nothing overwrites; `notification.html` remains as the latest copy; both `0600` |
| `down` ran immediately, no plan shown; `down --target` was ignored (always rolled back 1) | shows the plan, asks for `yes` (`--yes` outside a terminal), `--dry-run` available, `--target` works, refuses edited files |
| Dangerous-op rules matched across the whole Up section (`UPDATE … WHERE` as last statement was flagged; `UPDATE` without WHERE was missed if another statement had one; `TRUNCATE t`, `DROP` without `COLUMN`, schema-qualified tables, Mongo `deleteMany()`/`dropCollection()` were missed) | matched per statement; those forms are caught — some migrations that used to pass now need an `@allow` |
| MariaDB `DROP TABLE` of an existing table was reported as `ORPHAN_DROP_UP` | `DROP_TABLE` (data loss); `ORPHAN_DROP_UP` now means the table exists nowhere (likely a typo) |
| MongoDB: `dropDatabase()` in `down()` was auto-allowed if `up()` created any collection | always needs explicit approval |
| MongoDB: an apostrophe in a comment or a nested `{ … }` in `up()` cut the validated body short, hiding later calls | the whole body is validated — some migrations that used to pass now need an `@allow` |
| `status`, `up --dry-run`, `dcl:status`, `dcl --plan` created the changelog/checksum table and backfilled checksums | read-only — they work with a `SELECT`-only account and change nothing |
| `DROP DATABASE` in Up was reported under two codes (`DROP_DATABASE` + `DROP_SCHEMA`, or `DROP_DATABASE` + `DROP_DATABASE_CMD` on MongoDB), so `@allow: DROP_DATABASE` was never enough | one code per form; `@allow: DROP_DATABASE` releases `DROP DATABASE` / `.dropDatabase()` |
| Per-run notification copies (and `sync -o` reports) accumulated forever | only the newest `notifications.keepRuns` (default 20) of each name are kept; the latest copy always stays |

### Multi-Instance

A config can declare an `instances: [...]` array instead of (or alongside) flat connection fields; every command has a `*-all` counterpart (`up-all`, `status-all`, `dcl-all`, `dcl:status-all`, `dcl:verify-all`, `test-instances`) that runs across all of them. See [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md).

---

## 🛠️ CLI Command Reference

```bash
# Local
node src/cli.js <command> [options] -c <config-path>

# Docker
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

### DDL — single instance

| Command | What it does |
|---|---|
| `status` | Show applied vs. pending migrations. Read-only: works with a `SELECT`-only account, creates nothing (same for `up`/`down --dry-run`, `validate --pending-only`, `dcl:status`, `dcl --plan`) |
| `up [--dry-run] [--sanity-check] [--no-auto-rollback] [--target <m>] [--only <m>] [--instance <n>] [--allow-checksum-drift] [--allow-*] [--allow-open-transactions]` | Apply pending migrations. **Validates the migrations about to run first and refuses (nothing applied) if any fails** — same rules and `--allow-*` escape hatches as `validate`. Also refuses if an already-applied file's content no longer matches its recorded checksum — see below |
| `sync [--sanity-check] [--target <m>] [--only <m>] [-o <dir>] [--allow-checksum-drift] [--allow-*] [--allow-open-transactions]` | `status` → validate → `up` → diff → real current schema, plus a run notification email (`reports/notification.html`). **Errors (non-zero exit) if nothing was pending**, same validation and checksum refusals as `up` — see [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) |
| `down -n <N> [--target <m>] [--dry-run] [--yes] [--allow-checksum-drift] [--instance <n>] [--allow-open-transactions]` | Rollback the last N migrations (or down to and including `--target`). Shows the plan and asks you to type `yes`; outside a terminal it needs `--yes`. Refuses if a file to roll back was edited after being applied |
| `baseline [--all \| --up-to <m> \| --file <f>] [--dry-run]` | Mark existing migrations as already-applied, for onboarding an existing DB — see [docs/EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) |
| `reset [--yes]` | Delete changelog/checksum records only — **never** runs `down()` or touches schema/data. Dry-run (count only) unless `--yes` |
| `create <name>` | Scaffold a new DDL migration file |
| `validate [--pending-only] [--allow-dangerous] [--allow-forbidden] [--allow <codes>]` | Validate migration files (see [Validation](#🛡️-validation) below). `--pending-only` connects and checks only not-yet-applied files — exactly what `up`/`sync` will check |
| `test` | Up-Down-Up round-trip test |

### DDL — multi-instance

| Command | What it does |
|---|---|
| `status-all` | `status` across every instance in the config |
| `up-all [--dry-run] [--allow-checksum-drift] [--allow-*] [--allow-open-transactions]` | `up` across every instance, with the same validation / checksum / changelog-consistency gates per instance |
| `test-instances [-o <dir>] [--validate-only] [--parallel]` | `test` (or just `validate`) across every instance, with a combined report |
| `validate-all <dir> [--ddl-only \| --dcl-only] [--allow-*]` | Walk a whole project directory (DDL + DCL) and validate everything in it — e.g. `production-server/` |

### DCL — single instance

| Command | What it does |
|---|---|
| `dcl [--plan] [--dry-run] [--validate] [--allow-dangerous] [--allow-forbidden] [--approved-by <name>] [--accept-removed-dcl] [-o <dir>]` | Run pending/changed repeatable scripts, then print an account/permission before/after diff and write the run notification email (`<dir>/notification.html`, default `reports/`). `--plan` previews the run (script diffs, affected accounts and their grants, passwords to be generated) without executing |
| `dcl:status` | Show which `R__*` scripts are applied and whether their checksum still matches |
| `dcl:verify` | Run each script twice and diff state to confirm idempotency, without leaving changes applied for real use |
| `create-dcl <name> [-n <seq>] [--dir <dir>]` | Scaffold a new `R__` DCL migration file. When `migrationsDir` lists several directories, `--dir` (e.g. `shared`, `prod-tw`) says which one; a name already used in any listed directory is refused |

### DCL — multi-instance

| Command | What it does |
|---|---|
| `dcl-all [--dry-run] [--validate] [--allow-*] [-o <dir>] [--plan] [--accept-removed-dcl]` | `dcl` across every instance, each with its own `migrationsDir` if set — one `notification-<instance>.html` per instance (with that instance's passwords) plus a password-free `notification-summary.html` |
| `dcl:status-all` | `dcl:status` across every instance |
| `dcl:verify-all` | `dcl:verify` across every instance |

### Testing & Reports

| Command | What it does |
|---|---|
| `test` | Up-Down-Up for one config |
| `test-instances -o <dir>` | Up-Down-Up (or validate-only) across all instances |
| `test-all [-o <dir>] [--pattern <glob>] [--base-dir <dir>] [--console-only] [--sanity-check]` | Discover every `config.js` matching a glob and run validate + Up-Down-Up (DDL) or validate + idempotency (DCL) on each, with a combined pass/fail report |

---

## 📄 Configuration Examples

### MongoDB DDL

```javascript
// Only override what differs from defaults
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGODB_DB || 'myapp' }
};
```

### MariaDB DDL

```javascript
// host/port/user/password come from env vars (MARIADB_HOST etc.) or defaults
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
```

Every MariaDB DDL project also gets **Lock Guard** on by default (bounded lock-wait + retry around each migration's SQL). Override it per project if needed:

```javascript
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  ddlSafety: {
    lockGuard: {
      enabled: true,          // set false to restore the old unguarded behavior
      lockWaitTimeoutSec: 5,  // SESSION lock_wait_timeout while running migration SQL
      innodbLockWaitTimeoutSec: 5,
      maxRetries: 3,          // give up after this many lock-wait-timeout failures
      retryDelayMs: 2000
    }
  }
};
```

See [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md) for why this exists and what it does and doesn't protect against.

MongoDB DDL projects can bound each operation a migration issues (off by default — pick a limit your largest index build fits in):

```javascript
export default {
  type: 'mongodb',
  mongodb: { databaseName: 'myapp' },
  ddlSafety: { operationTimeoutMs: 60000 }   // an operation running longer is stopped and the run fails
};
```

One known-slow migration (e.g. a large index build) can get its own limit without loosening the rest — `// @operation-timeout-ms: 600000` at the top of the file (`0` = no limit for that file).

Before `up`/`sync`/`up-all` run, a pending MongoDB migration that builds an index or runs `updateMany`/`deleteMany`/`bulkWrite` on a collection with 1,000,000+ documents gets a warning naming the collection's size and the time limit that will apply (`runtimeGates.largeCollectionDocs` to change the threshold, `0` to turn it off). It never blocks.

Without the privilege the open-transaction check (R2) needs — `PROCESS` on MariaDB, `clusterMonitor` on MongoDB — it is skipped with a notice. For production, `runtimeGates: { requireLockCheck: true }` refuses such a run instead.

See Gate R5 in [docs/RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md).

### MongoDB DCL

```javascript
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },
  checksumCollection: '_dcl_migrations'
};
```

### MariaDB DCL

```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',
  checksumTable: '_dcl_migrations'
};
```

DCL `migrationsDir` can be a list — accounts every server needs plus this server's own (the same file name in two directories is rejected; DDL takes one directory):

```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',
  migrationsDir: ['./shared', './prod-tw']
};
```

Notification emails: `notifications: { keepRuns: 20 }` (default) keeps the newest 20 per-run copies of each file name; `0` keeps all. See [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md).

### Multi-instance (either type)

```javascript
export default {
  type: 'mariadb',
  instances: [
    { name: 'primary-db',   mariadb: { host: 'db-primary',   database: 'shop' } },
    { name: 'secondary-db', mariadb: { host: 'db-secondary', database: 'shop' } }
  ]
};
```

Full details: [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md).

---

## 📂 Project Structure

```
db-migrate/
├── src/                          # Core source code
│   ├── cli.js                    # All commands
│   ├── core/                     # RepeatableRunner, DCLIdempotentChecker, Reporter, ...
│   ├── adapters/                 # mariadb-adapter.js, mongodb-adapter.js
│   └── config-defaults/          # mariadb-ddl.js, mariadb-dcl.js, mongodb-ddl.js, mongodb-dcl.js
├── test-fixtures/                # Integration fixtures (run against real DBs)
│   ├── mariadb/                  # test-success, test-failure, multi-instance, production-server, fk-test, ...
│   └── mongodb/                  # test-success, test-failure, multi-instance, production-server
├── templates/                    # Copy-paste starting points per DB type — see templates/README.md
├── test/                         # Unit tests (vitest)
├── scripts/                      # CI/build shell scripts
├── docker/                       # Container entrypoint
├── k8s/                          # Example Kubernetes manifests for `sync` as a Job
└── docs/                         # Deep-dive documentation (index below)
```

---

## 🛡️ Validation

`up`, `sync` and `up-all` run these checks themselves, right before executing, on exactly the migrations about to run (pending, narrowed by `--target`/`--only`) — if any fails, nothing is applied and the run exits non-zero. Already-applied files are not re-judged: they ran under the rules of their day, and editing them to satisfy a newer rule would trip the checksum gate. `validate` runs the same checks without touching the database (`--pending-only` to check just what `up`/`sync` would).

Each file is checked for:

- **Forbidden operations**: `DROP DATABASE`, `CREATE USER`, `GRANT`, etc. showing up in a DDL file (they belong in DCL)
- **Dangerous operations**: `TRUNCATE TABLE`, `DROP COLUMN`, `DROP INDEX`, `collection.drop()`, etc.
- **SQL syntax errors** (MariaDB): pre-validated with `node-sql-parser` before the rule checks run
- **FK integrity** (MariaDB DDL): foreign keys pointing at tables that were dropped or never created
- **Empty `down()`**: `up()` has operations but `down()` doesn't undo them
- **Orphaned drops**: `down()` drops tables/collections that `up()` never created
- **No `-- +migrate Up` section** (MariaDB): such a file would never run and stay pending forever, so it's rejected (`MISSING_UP_MARKER`)

In a versioned (DDL) directory, `R__*` files are ignored by `status`/`up`/`down`/`validate` on both databases (with a warning) — repeatable scripts belong in a DCL project (`mode: 'repeatable'`).

### Allowance mechanisms

```bash
# Allow all dangerous operations (CLI flag)
node src/cli.js validate --allow-dangerous -c <config>

# Allow specific operation codes
node src/cli.js validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

The same flags work on `up`/`sync`/`up-all`. Every allowance actually used (flag or annotation) is printed in the run log, so the approval is visible there too.

For forbidden (🔴) operations, record **who** approved it: `-- @approved-by: Alice (CAB-1042)` in the file, or `--approved-by "Alice (CAB-1042)"` for the run. The approver is printed with each allowance and listed under **Approved exceptions** in the notification email of `sync`, and of `dcl` / `dcl-all` run with `--validate`. `validation: { requireApprover: true }` makes it mandatory — a forbidden allowance without an approver is refused (`APPROVER_REQUIRED`).

Some failures can't be allowed, only fixed in the file — e.g. a syntax error, a missing Up/Down section, or schema DDL inside a DCL file. The refusal message says which.

Approvals and known tables can also live in the config — useful for files that are already applied, or tables that predate your migrations:

```javascript
validation: {
  existingTables: ['legacy_users'],                          // MongoDB: existingCollections
  allow: { '20260101000005-drop-legacy.sql': ['DROP_TABLE'] }
}
```

Per-file annotation (recommended — keeps the approval traceable in code review):

```sql
-- @allow: DROP_COLUMN
-- @approved-by: Alice (ticket #123) — deprecated since v2.0

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

Full rules: [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md), [docs/VALIDATION-RULES-MARIADB.md](docs/VALIDATION-RULES-MARIADB.md), [docs/VALIDATION-RULES-MONGODB.md](docs/VALIDATION-RULES-MONGODB.md).

---

## 🚢 Deployment

- **Docker Compose** — the primary local/dev/CI workflow. Full command reference: [docs/CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) (every command shown in both `node`/`docker compose run` form), [docs/DOCKER-COMPOSE-USER-GUIDE.md](docs/DOCKER-COMPOSE-USER-GUIDE.md).
- **Kubernetes** — example manifests in [`k8s/`](k8s/) run `sync` as a one-shot Job: a ServiceAccount scoped to one Secret, migrations delivered via a content-hashed ConfigMap, `backoffLimit: 0` (a half-applied DDL migration should surface to a human, not be silently retried by the scheduler). See [`k8s/README.md`](k8s/README.md) for the full workflow, the pre-flight checklist, and why the DB user in the Secret should **not** be the database superuser.

---

## 🧪 Testing

```bash
npm test                 # Unit tests (vitest)
npm run test:coverage    # Unit tests + coverage; fails below the floors in vitest.config.js (CI runs this)
npm run lint             # ESLint; any warning fails (--max-warnings 0)
npm run test:integration # Integration tests against real DBs (vitest.integration.config.js); skips without a DB unless INTEGRATION_REQUIRE_DB=1
npm run docker:test      # Full e2e: builds the image, brings up MongoDB + MariaDB, runs test-all
```

Coverage floors (`coverage.thresholds` in `vitest.config.js`) sit just under what the unit tests reach today, so coverage can't quietly slide; `src/cli.js` counts as 0% there because it's exercised by `docker:test` and the integration suite instead. Raise the floors as coverage improves. The CI image build pushes `ghcr.io/<owner>/db-migrate/db-migrate` with tags `latest`, the branch name and the commit SHA.

`docker:test` is the most representative check — it's the same `test-all` command a CI pipeline runs, against real containers, producing the same JSON/HTML report. See [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md) and [docs/CI-MIGRATION-TEST-GUIDE.md](docs/CI-MIGRATION-TEST-GUIDE.md).

---

## 📚 Documentation Index

The full index, grouped by task, is **[docs/README.md](docs/README.md)**. The ones you'll want first:

| Document | Description |
|---|---|
| [DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) | **Start here for production** — what causes lock-ups, the protections, pre-flight checklist, abort/rollback runbook |
| [CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) | Every command, in `node` and `docker compose run` form |
| [USER-GUIDE-MARIADB.md](docs/USER-GUIDE-MARIADB.md) / [USER-GUIDE-MONGODB.md](docs/USER-GUIDE-MONGODB.md) | Writing migration files |
| [VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) | Validation, allowances, per-project rule policy and custom rules |
| [DCL-PASSWORD.md](docs/DCL-PASSWORD.md) | Generated passwords, notification emails, `dcl --plan` |
| [RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md) | Checks made before anything executes |
| [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | Testing locally and in CI |
| [`k8s/README.md`](k8s/README.md) | Running `sync` as a Kubernetes Job |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Run unit tests: `npm test` (and `npm run docker:test` if you touched adapter/execution logic)
4. Submit a pull request

---

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.
