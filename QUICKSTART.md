# Quick Start — a task-oriented runbook

> This document is organized by "what do I want to do" — it shows you how to use `docker compose run --rm migrate` for common tasks.
> For full CLI options, config file formats, and validation rules, see [README.md](README.md).

---

## 0. Prerequisites & starting the databases

- **Docker Desktop**. On Windows, Docker Desktop needs WSL2 to start its engine (Windows Home has no Hyper-V):
  ```powershell
  # Open PowerShell as Administrator, run this, then reboot
  wsl --install
  ```
  After the reboot, just start Docker Desktop (it registers the `docker-desktop` WSL2 distro automatically).
- Or: local Node.js ≥ 22.12 with a reachable MariaDB/MongoDB of your own.

Start the test databases:

```bash
docker compose up -d mariadb mongodb
```

Basic command shape:

```bash
# Local
node src/cli.js <command> [options] -c <config-path>

# Docker (recommended — consistent environment)
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

The examples below all use the Docker form — swap the path for your own project's config.

---

## I want to... create and apply a new DDL migration (schema change)

```bash
# 1. Create a new migration
docker compose run --rm migrate create create-users -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 2. Edit config.js — only fill in fields that differ from the defaults (delta pattern)
#    export default {
#      type: 'mariadb',
#      database: process.env.MARIADB_DB || 'myapp',
#    };

# 3. Edit the generated SQL/JS file (write Up, and Down — an empty Down is blocked by validate)

# 4. Validate
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. Apply
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

Updating an *existing* table's schema is the same flow — `create` still generates a timestamped file, you just write `ALTER TABLE ... ADD COLUMN ...` (with the matching `DROP COLUMN` in Down) instead of `CREATE TABLE`:

```sql
-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL;

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

```javascript
// MongoDB equivalent — no ALTER TABLE, just update documents / add a validator
export async function up(db, client) {
  await db.collection('users').updateMany({ phone: { $exists: false } }, { $set: { phone: null } });
}
export async function down(db, client) {
  await db.collection('users').updateMany({}, { $unset: { phone: '' } });
}
```

### DDL command reference

| Command | Description |
|---|---|
| `status` | Show migration status |
| `up` | Apply pending migrations |
| `up --sanity-check` | Apply with Pre-Check/Post-Check (auto-rollback on failure) |
| `up --dry-run` | Preview what would run, without applying it |
| `down -n 1` | Roll back the last 1 migration |
| `validate` | Validate migration files (syntax, dangerous ops, FK integrity…) |
| `test` | Run an Up→Down→Up round trip |
| `create <name>` | Create a new migration file |
| `baseline --all` | Onboarding an existing database — mark existing migrations as "applied" without running them |

---

## I want to... "apply + see the diff + see the current schema" in one shot

That's what `sync` is for — built for CI/CD and deploy pipelines, replacing the manual status → up → check-for-yourself three-step:

```bash
docker compose run --rm migrate sync -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# Save a JSON+HTML report too (e.g. to upload as a CI artifact)
docker compose run --rm migrate sync -o /app/reports -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

`sync` runs, in order:
1. Check current status (`status`)
2. Apply all pending migrations (`up`)
3. Print a **before/after schema diff** (git-diff style, not two full listings you have to compare yourself)
4. Print the **real schema** after applying — queried straight from the database, not inferred from migration files

It also writes a **run notification email** (`notification.html`, see [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md)) listing the migrations applied and the schema diff — defaults to `reports/notification.html`, independent of the `-o`-gated JSON+HTML report above.

⚠️ **Note**: if there is nothing pending when it runs, `sync` **returns a non-zero exit code** instead of silently doing nothing — this is deliberate, so CI/CD can't mistake "nothing to do" for "deployment succeeded." Details in [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md).

Want to run `sync` as a one-shot Kubernetes Job? See [Deploying to Kubernetes](#i-want-to-deploy-to-kubernetes) below.

---

## I want to... create/modify DCL accounts & permissions (repeatable mode)

```bash
# 1. Create a new DCL migration
docker compose run --rm migrate create-dcl readonly_users -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 2. Edit config.js — again, only the delta
#    export default {
#      type: 'mariadb',
#      mode: 'repeatable',
#      database: 'mysql',
#      checksumTable: '_dcl_migrations',
#    };

# 3. Edit the accounts/grants in migrations/*.sql (must be idempotent — e.g. CREATE USER IF NOT EXISTS)

# 4. Verify idempotency first, then actually run it
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

`dcl` prints **this run's account/permission before/after diff** (MariaDB and MongoDB both supported) so a reviewer sees exactly what changed at a glance, instead of having to diff the account list against the database themselves.

It also writes a **run notification email** (`reports/notification.html` by default) with one row per account event — new account, password rotated, no change, account removed, permissions updated. A generated or rotated password appears **only** in that email, in plaintext, as a one-time temporary credential — never in the console, never written back to the migration file. See [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md) for the full mechanism and the Kubernetes retrieval pattern.

To change permissions or add accounts later, just edit the SQL/JS file and rerun `dcl` — it only re-runs when the checksum changes; unchanged files are skipped.

### DCL command reference

| Command | Description |
|---|---|
| `dcl` | Run DCL migrations, then print the account/permission diff and write the notification email |
| `dcl --dry-run` | Preview what DCL would run, without running it |
| `dcl:status` | Show each DCL file's applied status and whether its checksum matches |
| `dcl:verify` | Verify DCL idempotency (runs twice, compares state, leaves no lasting change) |
| `create-dcl <name>` | Create a new DCL file |

---

## I want to... do the same thing across multiple database instances (multi-instance)

If config.js defines multiple instances via `instances: [...]` (e.g. primary/secondary), every single-instance command has a `*-all` counterpart:

```bash
docker compose run --rm migrate status-all      -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
docker compose run --rm migrate up-all          -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
docker compose run --rm migrate dcl-all         -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate dcl:status-all  -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate dcl:verify-all  -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate test-instances -o /app/reports -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

`dcl-all` writes one notification email per instance (`reports/notification-<instance-name>.html`, holding only that instance's passwords) plus `reports/notification-summary.html`, an overview with no passwords. Instances can each manage different accounts via their own `migrationsDir` — see [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md).

Config file format and full details: [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md).

---

## I want to... validate an entire project directory (not just one config)

```bash
# Validate all DDL + DCL migrations under a project
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server

# DDL only, or DCL only
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server --ddl-only
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server --dcl-only
```

When validation blocks a dangerous/forbidden operation, there are two ways to allow it (pick one):

```bash
# Allow via CLI flag (applies to this run only)
docker compose run --rm migrate validate --allow-dangerous -c <config>
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

```sql
-- Allow via in-file annotation (recommended — the approval stays in code review history)
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

Full validation rules: [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md).

---

## I want to... run the full test suite

```bash
# Single config: Up → Down → Up round trip
docker compose run --rm migrate test -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# Multi-instance: run once per instance
docker compose run --rm migrate test-instances -o /app/reports -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Whole project (or all of test-fixtures/): validate + Up-Down-Up / idempotency, one run, one report
docker compose run --rm migrate test-all -o /app/reports --pattern "test-fixtures/**/config.js"
```

Or run it all locally in one command (same e2e flow CI runs — builds the image, starts the DBs, runs `test-all`):

```bash
npm run docker:test
```

Manual step-by-step test flow:

```bash
# 1. Start the DB
docker compose up -d mariadb

# 2. DCL — create accounts
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 3. DDL — validate
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 4. DDL — up (with sanity check)
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. DDL — down
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 6. DDL — up again
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 🍃 MongoDB guide

### DCL (account & permission management)

```bash
docker compose run --rm migrate create-dcl my_users -c /app/test-fixtures/mongodb/my-project/dcl/config.js
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mongodb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mongodb/my-project/dcl/config.js
```

### DDL (schema changes)

```bash
docker compose run --rm migrate create create-users -c /app/test-fixtures/mongodb/my-project/ddl/config.js
docker compose run --rm migrate up -c /app/test-fixtures/mongodb/my-project/ddl/config.js
docker compose run --rm migrate test -c /app/test-fixtures/mongodb/my-project/ddl/config.js
```

### MongoDB built-in role reference

| Role | Permissions |
|---|---|
| `read` | Read-only (find, listCollections) |
| `readWrite` | Read/write (CRUD operations) |
| `dbAdmin` | Database administration (indexes, stats, validation) |
| `dbOwner` | Full access (readWrite + dbAdmin + userAdmin) |
| `userAdmin` | User management |

---

## I want to... deploy to Kubernetes

[`k8s/`](k8s/) has example manifests that package `sync` as a one-shot Job:

- Credentials come from a Secret (**not** the database's real superuser — see `k8s/README.md`)
- Migration files are delivered via a content-hashed ConfigMap (not baked into the image)
- `backoffLimit: 0` — a half-applied DDL migration should stop and wait for a human, not be silently retried by the scheduler

```bash
kubectl wait --for=condition=complete job/db-migrate-shop-sync-<hash> --timeout=900s -n <namespace>
kubectl logs job/db-migrate-shop-sync-<hash> -n <namespace>
```

Fetching the notification email out of the Job pod — `kubectl exec <pod> -n <namespace> -- cat /app/reports/notification.html` — has to happen while the container is still alive (right after the command that wrote it), not after the Job completes; see [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md) for why `ttlSecondsAfterFinished` doesn't give you a usable window for this.

Run through the checklist in [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) section 5 before pointing this at production. Full workflow: [`k8s/README.md`](k8s/README.md).

---

## Troubleshooting

**Docker Desktop won't start on Windows / `docker ps` can't reach the engine**
Docker Desktop on Windows Home depends on WSL2 for its Linux engine. Run `wsl --install` as Administrator, reboot, then start Docker Desktop.

**Seeing `⚠️ Lock wait timeout (attempt N/3), retrying...` while running DCL**
That's the protection mechanism working as intended, not an error — it means this `ALTER TABLE` is queued behind another long transaction's metadata lock, and the guard is retrying per its configuration; it only actually fails once retries are exhausted. Details in [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md).

---

## 📖 Full documentation

For complete CLI options, config file formats, and validation rules, see [README.md](README.md). For a deeper Q&A walkthrough of scenarios like removing an account or onboarding an existing database — with flowcharts of what actually happens internally — see [docs/E2E-SCENARIOS.md](docs/E2E-SCENARIOS.md). More detailed guides under [docs/](./docs/), e.g. [docs/CLI-USAGE-GUIDE.md](./docs/CLI-USAGE-GUIDE.md).
