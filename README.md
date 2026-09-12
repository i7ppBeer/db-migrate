# DB-Migrate v2.1

> Unified DDL + DCL migration tool for MongoDB and MariaDB/MySQL — versioned schema migrations, repeatable account/permission management, multi-instance rollout, and production guardrails (lock-wait protection, dangerous-operation validation, sanity checks) behind one CLI.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
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
- **Validation before execution** — forbidden ops (DCL statements inside DDL), dangerous ops (`TRUNCATE`, `DROP COLUMN`, `collection.drop()`, …), empty `down()`, orphaned drops, FK integrity (MariaDB), and a SQL syntax pre-check — each with an explicit, reviewable escape hatch (`--allow`, `@allow` file annotation) rather than a silent bypass.
- **Lock Guard (MariaDB)** — every DDL statement runs under a bounded `lock_wait_timeout` with retry, so an `ALTER TABLE` stuck behind a long-running transaction's metadata lock fails fast instead of queuing indefinitely and jamming every later query on that table. See [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md).
- **Sanity Check** — optional Pre-Check / Post-Check assertions per migration, with auto-rollback if the post-condition doesn't hold.
- **DCL auto-generated passwords** — a `CHANGE_ME_ON_FIRST_LOGIN` placeholder in a DCL script is replaced at runtime with its own cryptographically secure, independently generated password (never printed, never written back to the file); the credential is appended to `/tmp/secret` for one-time retrieval. See [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md).
- **Reports** — `sync`, `test-all`, and `test-instances` can all emit a JSON + HTML report via `-o <dir>`.
- **Kubernetes-ready** — example manifests in [`k8s/`](k8s/) for running `sync` as a one-shot Job, credentials from a Secret, migrations from a content-hashed ConfigMap.

---

## 📦 Installation

```bash
git clone https://github.com/your-org/db-migrate.git
cd db-migrate
npm install
```

Requires Node.js ≥ 20. For local development against real databases you'll also want Docker (see below) — on Windows that means Docker Desktop with the WSL2 backend enabled (`wsl --install`, since Windows Home has no Hyper-V).

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

`loadConfig()` picks a built-in defaults file from `src/config-defaults/` based on `type` + `mode` (`mariadb-ddl.js`, `mariadb-dcl.js`, `mongodb-ddl.js`, `mongodb-dcl.js`), then deep-merges your config on top. **Your `config.js` only needs to export what differs from the defaults** — host/port/credentials, lock guard tuning, etc. all fall back sensibly.

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
| `status` | Show applied vs. pending migrations |
| `up [--dry-run] [--sanity-check] [--no-auto-rollback] [--target <m>] [--only <m>] [--instance <n>]` | Apply pending migrations |
| `sync [--sanity-check] [--target <m>] [--only <m>] [-o <dir>]` | `status` → `up` → diff → real current schema. **Errors (non-zero exit) if nothing was pending** — see [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) |
| `down -n <N> [--target <m>] [--instance <n>]` | Rollback the last N migrations |
| `baseline [--all \| --up-to <m> \| --file <f>] [--dry-run]` | Mark existing migrations as already-applied, for onboarding an existing DB — see [docs/EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) |
| `reset [--yes]` | Delete changelog/checksum records only — **never** runs `down()` or touches schema/data. Dry-run (count only) unless `--yes` |
| `create <name>` | Scaffold a new DDL migration file |
| `validate [--allow-dangerous] [--allow-forbidden] [--allow <codes>]` | Validate migration files (see [Validation](#🛡️-validation) below) |
| `test` | Up-Down-Up round-trip test |

### DDL — multi-instance

| Command | What it does |
|---|---|
| `status-all` | `status` across every instance in the config |
| `up-all [--dry-run]` | `up` across every instance |
| `test-instances [-o <dir>] [--validate-only] [--parallel]` | `test` (or just `validate`) across every instance, with a combined report |
| `validate-all <dir> [--ddl-only \| --dcl-only] [--allow-*]` | Walk a whole project directory (DDL + DCL) and validate everything in it — e.g. `production-server/` |

### DCL — single instance

| Command | What it does |
|---|---|
| `dcl [--dry-run] [--validate] [--allow-dangerous] [--allow-forbidden]` | Run pending/changed repeatable scripts, then print an account/permission before/after diff |
| `dcl:status` | Show which `R__*` scripts are applied and whether their checksum still matches |
| `dcl:verify` | Run each script twice and diff state to confirm idempotency, without leaving changes applied for real use |
| `create-dcl <name> [-n <seq>]` | Scaffold a new `R__` DCL migration file |

### DCL — multi-instance

| Command | What it does |
|---|---|
| `dcl-all [--dry-run] [--validate] [--allow-*]` | `dcl` across every instance |
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
├── test/                         # Unit tests (vitest)
├── scripts/                      # CI/build shell scripts
├── docker/                       # Container entrypoint
├── k8s/                          # Example Kubernetes manifests for `sync` as a Job
└── docs/                         # Deep-dive documentation (index below)
```

---

## 🛡️ Validation

The `validate` command checks each migration file for:

- **Forbidden operations**: `DROP DATABASE`, `CREATE USER`, `GRANT`, etc. showing up in a DDL file (they belong in DCL)
- **Dangerous operations**: `TRUNCATE TABLE`, `DROP COLUMN`, `DROP INDEX`, `collection.drop()`, etc.
- **SQL syntax errors** (MariaDB): pre-validated with `node-sql-parser` before the rule checks run
- **FK integrity** (MariaDB DDL): foreign keys pointing at tables that were dropped or never created
- **Empty `down()`**: `up()` has operations but `down()` doesn't undo them
- **Orphaned drops**: `down()` drops tables/collections that `up()` never created

### Allowance mechanisms

```bash
# Allow all dangerous operations (CLI flag)
node src/cli.js validate --allow-dangerous -c <config>

# Allow specific operation codes
node src/cli.js validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

Per-file annotation (recommended — keeps the approval traceable in code review):

```sql
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

Full rules: [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md), [docs/VALIDATION-RULES-MARIADB.md](docs/VALIDATION-RULES-MARIADB.md), [docs/VALIDATION-RULES-MONGODB.md](docs/VALIDATION-RULES-MONGODB.md).

---

## 🚢 Deployment

- **Docker Compose** — the primary local/dev/CI workflow. Full command reference: [docs/DOCKER-USAGE.md](docs/DOCKER-USAGE.md), [docs/DOCKER-COMPOSE-USER-GUIDE.md](docs/DOCKER-COMPOSE-USER-GUIDE.md).
- **Kubernetes** — example manifests in [`k8s/`](k8s/) run `sync` as a one-shot Job: a ServiceAccount scoped to one Secret, migrations delivered via a content-hashed ConfigMap, `backoffLimit: 0` (a half-applied DDL migration should surface to a human, not be silently retried by the scheduler). See [`k8s/README.md`](k8s/README.md) for the full workflow, the pre-flight checklist, and why the DB user in the Secret should **not** be the database superuser.

---

## 🧪 Testing

```bash
npm test                 # Unit tests (vitest)
npm run test:integration # Integration tests against real DBs (vitest.integration.config.js)
npm run docker:test      # Full e2e: builds the image, brings up MongoDB + MariaDB, runs test-all
```

`docker:test` is the most representative check — it's the same `test-all` command a CI pipeline runs, against real containers, producing the same JSON/HTML report. See [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md) and [docs/CI-MIGRATION-TEST-GUIDE.md](docs/CI-MIGRATION-TEST-GUIDE.md).

---

## 📚 Documentation Index

| Document | Description |
|---|---|
| [DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) | **Start here for prod DDL risk** — what causes lock-ups, pre-flight checklist, abort/rollback runbook |
| [LOCK-GUARD.md](docs/LOCK-GUARD.md) | MariaDB lock-wait guard: config, error behavior, and its limits |
| [RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md) | Pre-flight readiness gates (design, not yet all implemented) |
| [VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) | Full validation rules reference |
| [VALIDATION-RULES-MARIADB.md](docs/VALIDATION-RULES-MARIADB.md) | MariaDB validation rule tables, FK integrity checks |
| [VALIDATION-RULES-MONGODB.md](docs/VALIDATION-RULES-MONGODB.md) | MongoDB validation rule tables |
| [DCL-PASSWORD.md](docs/DCL-PASSWORD.md) | DCL auto-generated password mechanism |
| [MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md) | Multi-instance configuration guide |
| [EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) | Onboarding an existing database with `baseline` |
| [CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) | Detailed CLI usage guide |
| [USER-GUIDE-MARIADB.md](docs/USER-GUIDE-MARIADB.md) / [USER-GUIDE-MONGODB.md](docs/USER-GUIDE-MONGODB.md) | Per-database user guides |
| [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | `test-all`, `validate-all`, CI/CD integration |
| [CI-MIGRATION-TEST-GUIDE.md](docs/CI-MIGRATION-TEST-GUIDE.md) | Wiring migration tests into CI |
| [DOCKER-USAGE.md](docs/DOCKER-USAGE.md) / [DOCKER-COMPOSE-USER-GUIDE.md](docs/DOCKER-COMPOSE-USER-GUIDE.md) | Docker Compose command reference |
| [BUILD-IMAGE-GUIDE.md](docs/BUILD-IMAGE-GUIDE.md) | Building the migration image |
| [LOCAL-TEST-GUIDE.md](docs/LOCAL-TEST-GUIDE.md) | Running the test suite locally without Docker |
| [MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md](docs/MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md) | Ops-runbook-style migration management guide |
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
