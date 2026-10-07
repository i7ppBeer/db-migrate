# Database Migration Operations Guide

Every command below runs either as `node src/cli.js <command> ...` (local Node) or
`docker compose run --rm migrate <command> ...` (no local Node needed — container
paths use `/app/` in place of the repo root, e.g. `/app/test-fixtures/...`). Both
forms take identical flags; only the prefix and path root differ.

## Directory Structure

```
test-fixtures/
├── mariadb/
│   ├── production-server/
│   │   ├── ddl/                 # DDL (versioned migrations)
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── dcl/                 # DCL (repeatable migrations)
│   │       ├── config.js
│   │       └── migrations/
│   ├── test-success/
│   │   ├── ddl/
│   │   └── dcl/
│   ├── test-failure/
│   │   ├── ddl/
│   │   └── dcl/
│   └── multi-instance/          # multiple database instances
│       ├── config.js
│       └── migrations/
└── mongodb/
    └── (same structure as above)
```

## Basic Commands

### 1. Check Migration Status

```bash
# Check MariaDB DDL migration status
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status

# Check MongoDB DDL migration status
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js status
```

`status`, `status-all`, `up --dry-run`, `up-all --dry-run`, `down --dry-run`, `validate` (including `--pending-only`), `dcl:status`, `dcl:status-all`, `dcl --plan` / `--dry-run` and `dcl-all --plan` / `--dry-run` are **read-only**: they never create the changelog or checksum table (or the database), and never backfill checksums. They work with an account that only has `SELECT` on the database (`SELECT` on `mysql.*` too for `dcl --plan`'s current-grants view on MariaDB); a database where nothing has been applied yet simply shows everything as pending. Commands that write still need the usual privileges.

### 2. Run Migrations (UP)

```bash
# Run all pending migrations
node src/cli.js -c <config-path> up

# Simulate execution (does not actually run anything)
node src/cli.js -c <config-path> up --dry-run

# Enable sanity check (automatically rolls back failed migrations)
node src/cli.js -c <config-path> up --sanity-check

# Disable auto-rollback
node src/cli.js -c <config-path> up --sanity-check --no-auto-rollback
```

### 3. Roll Back Migrations (DOWN)

```bash
# Roll back the last migration
node src/cli.js -c <config-path> down

# Roll back the last N migrations
node src/cli.js -c <config-path> down -n 3
```

### 4. Reset Migration Records (RESET)

Deletes **all** records from the changelog (DDL) or checksum (DCL) table/collection, so the next `status`/`up`/`dcl` treats every migration as pending. It does **not** run `down()`, and it does **not** touch the actual tables/collections or data — it only clears the tool's own tracking records.

```bash
# Default is dry-run: only prints how many records would be deleted, without actually deleting anything
node src/cli.js -c <config-path> reset

# Add --yes to actually perform the deletion
node src/cli.js -c <config-path> reset --yes
```

⚠️ Since only the records are cleared and the actual data isn't, running `up` again after a reset will very likely fail because the tables/collections already exist (unless the migration itself uses `IF NOT EXISTS`). **This is generally only meant for development/test databases that get reset entirely** — production environments will almost never need it.

### 5. One Step: Check, Apply, and See the Result (SYNC)

Chains `status` → `up` → prints what was actually applied → shows the database's actual current schema, all in one step. **If there are no pending migrations, this is treated as an error and aborts** (non-zero exit code) rather than passing silently — in a deployment context, "expected something to update but there was nothing to update" usually means something went wrong.

```bash
node src/cli.js -c <config-path> sync

# With sanity check
node src/cli.js -c <config-path> sync --sanity-check

# Also save a JSON + HTML report to the given directory
node src/cli.js -c <config-path> sync -o ./reports
```

`-o <dir>` produces two files, `sync-report-<timestamp>.json` and `.html`, containing: which migrations were applied this run, whether there were any errors, and the database's actual post-apply schema (for MariaDB, columns listed per table; for MongoDB, indexes per collection plus a field shape inferred from a sample document). On failure, only the error information is saved — no schema snapshot is attached for an uncertain state.

### 6. DCL Account/Permission Change Diff

The `dcl` command takes an account/permission snapshot both before and after it runs (reusing the state-capture logic that `dcl:verify`'s idempotency check already has), and automatically shows a diff if any migration was applied:

```bash
node src/cli.js -c <config-path> dcl
```

```
[DCL] Account/permission changes (mariadb):
────────────────────────────────────────────────────────
+ 👤 app_writer@%(new account)
   + GRANT INSERT, UPDATE ON mydb.* TO ... (app_writer@%)
- 👤 old_service@%(account dropped)
~ 👤 app@%(permission changed)
   + GRANT INSERT ON mydb.* TO ...
   - GRANT DELETE ON mydb.* TO ...
────────────────────────────────────────────────────────
```

MongoDB shows account + role changes (using the same `+`/`-`/`~` style); MariaDB shows account + GRANT changes. **A rename is not called out specially** — `RENAME USER` (or Mongo's drop-then-create) looks, under this before/after snapshot comparison, like "one account was dropped and a new one appeared," because comparing state alone can't tell whether it's a genuine rename or a coincidental drop-and-create.

---

## 🎯 Targeting Specific Migrations

### --target: Run Up To a Specific Migration (Inclusive)

Runs every migration from the first pending one up to and including the specified migration.

```bash
# Run up to create-orders (includes create-users, seed-users, create-products, create-orders)
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target 20250101000004-create-orders.sql

# Supports partial matching (matches as long as the name contains the string)
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target create-orders

# MongoDB example
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up --target seed-users
```

### --only: Run Only a Single Specified Migration

Runs only one specific migration (it must be in the pending list).

```bash
# Run only add-user-profile
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only 20250101000005-add-user-profile.sql

# Supports partial matching
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only add-user-profile

# MongoDB example
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up --only create-products
```

### Combined Usage Example

```bash
# First check the status
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status

# Result:
# ✅ Applied (2):
#    20250101000001-create-users.sql
#    20250101000002-seed-users.sql
# ⏳ Pending (4):
#    20250101000003-create-products.sql
#    20250101000004-create-orders.sql
#    20250101000005-add-user-profile.sql
#    20250101000006-add-phone-with-sanity.sql

# Run only up to create-orders (runs products and orders)
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target create-orders

# Skip add-user-profile, run only add-phone-with-sanity
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only add-phone-with-sanity
```

---

## 🔄 Multiple Database Instances

### Config File Example (multi-instance/config.js)

```javascript
export default {
  type: 'mariadb',
  migrationsDir: './migrations',
  changelogTable: '_migrations',
  
  instances: [
    {
      name: 'primary-db',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_primary',
        user: 'root',
        password: 'password'
      }
    },
    {
      name: 'secondary-db',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_secondary',
        user: 'root',
        password: 'password'
      }
    }
  ]
};
```

### Multi-Instance Commands

```bash
# Test all instances (validate + Up-Down-Up test)
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances

# Validate only, without running migration tests
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances --validate-only

# Run in parallel (faster, but uses more resources)
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances --parallel
```

---

## 🔍 Validating Migrations

### Validating Migration File Safety

```bash
# Validate DDL migrations (checks for dangerous operations, DCL mixed in, etc.)
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js validate

# Validate the failure case (should report an error)
node src/cli.js -c test-fixtures/mariadb/test-failure/ddl/config.js validate
```

Validation checks for:
- 🔴 **Forbidden operations**: DROP DATABASE, user management (should be in DCL)
- 🟠 **Dangerous operations**: TRUNCATE, DROP TABLE (with no matching CREATE)
- 🟡 **Warnings**: operations that may affect performance

### `up` / `sync` / `up-all` validate before running

You don't have to remember to run `validate` first: `up`, `sync` and `up-all` run the same checks on the migrations they're about to execute, and refuse — nothing applied, exit 1 — if any fails. The refusal lists each file's problems and, for the ones that can be overridden, the exact `--allow` value. Already-applied files aren't re-checked.

```bash
# See what sync would check, without applying anything (connects to the DB)
node src/cli.js validate --pending-only -c <config>

# up --dry-run also reports whether the run would be refused
node src/cli.js up --dry-run -c <config>

# A reviewed exception: prefer an annotation in the file (visible in code review) …
#   -- @allow: DROP_COLUMN
# … or pass it for this run only
node src/cli.js sync --allow DROP_COLUMN -c <config>
```

Every allowance used is printed in the run log (`⚠️ Allowed in <file> [CODE]: …`). For a forbidden (🔴) operation, record who approved it — `-- @approved-by: <name>` in the file or `--approved-by <name>` for the run; the log line then ends with `— approved by <name>` and the notification email of `sync`, `dcl` and `dcl-all` (with `--validate`) lists it under **Approved exceptions**. With `validation.requireApprover: true` in the config, a forbidden allowance without an approver is refused (`APPROVER_REQUIRED`). See [VALIDATION-RULES-REFERENCE.md](VALIDATION-RULES-REFERENCE.md#recording-who-approved-a-forbidden-operation).

---

## 📊 CI/CD Test Flow

### Full CI Test (Up → Down → Up)

```bash
# 1. Reset the database
docker exec test-mariadb mariadb -uroot -prootpass -e "DROP DATABASE IF EXISTS test_db; CREATE DATABASE test_db;"

# 2. Check the initial status
node src/cli.js -c <config> status

# 3. Run UP
node src/cli.js -c <config> up

# 4. Run DOWN
node src/cli.js -c <config> down

# 5. Run UP again
node src/cli.js -c <config> up

# 6. Check the final status
node src/cli.js -c <config> status
```

### Using the Test Command

```bash
# Automatically run the full test flow (single database)
node src/cli.js -c <config> test

# Multi-instance test
node src/cli.js -c <config> test-instances
```

---

## 📁 Common Config Paths

| Type | Path |
|------|------|
| MariaDB DDL success case | `test-fixtures/mariadb/test-success/ddl/config.js` |
| MariaDB DCL success case | `test-fixtures/mariadb/test-success/dcl/config.js` |
| MariaDB DDL failure case | `test-fixtures/mariadb/test-failure/ddl/config.js` |
| MariaDB multi-instance | `test-fixtures/mariadb/multi-instance/config.js` |
| MongoDB DDL success case | `test-fixtures/mongodb/test-success/ddl/config.js` |
| MongoDB DCL success case | `test-fixtures/mongodb/test-success/dcl/config.js` |
| MongoDB multi-instance | `test-fixtures/mongodb/multi-instance/config.js` |

---

## 🐳 Docker Test Environment

### Starting the Test Databases

```bash
# Start MongoDB and MariaDB
docker compose -f docker-compose.yml up -d mongodb mariadb

# Check status
docker compose -f docker-compose.yml ps

# View logs
docker compose -f docker-compose.yml logs -f
```

### Database Connection Info

| Database | Host | Port | User | Password | Database |
|--------|------|------|------|----------|----------|
| MariaDB | localhost | 3306 | root | rootpass | test_* |
| MongoDB | localhost | 27017 | - | - | test_* |

---

## ⚠️ Notes

1. **DDL vs DCL separation**:
   - DDL (Data Definition Language): structural changes such as CREATE TABLE, ALTER TABLE
   - DCL (Data Control Language): permission management such as CREATE USER, GRANT
   - DCL should use Repeatable mode, with files named `R__xxx.sql`

2. **--only limitation**:
   - Can only run migrations that are in the **pending list**
   - If a migration has already run, you need to `down` before `up`

3. **Multi-instance notes**:
   - All instances share the same migration files, unless an instance sets its own `migrationsDir`
   - Each instance has its own changelog table

7. **DCL: preview and removed scripts**:
   - `dcl --plan` (and `dcl-all --plan`) shows, without executing: what changed in each pending script since it was applied, every account it names with its current grants, and which passwords would be generated
   - If an applied `R__` script was deleted, `dcl:status` lists it and `dcl` refuses until it's restored or `--accept-removed-dcl` confirms the removal (accounts are left untouched)

6. **`down` asks first**:
   - It prints exactly which migrations it will roll back (most recent first) and waits for you to type `yes`
   - `--dry-run` only prints the plan; `--target <m>` rolls back everything after `<m>` and `<m>` itself
   - In scripts/CI (no terminal) it refuses unless you pass `--yes`
   - If a file to roll back was edited after being applied, it refuses unless `--allow-checksum-drift`

5. **Things that stop a run instead of guessing**:
   - No MariaDB credentials configured (`MARIADB_USER`/`MARIADB_PASSWORD` or `user`/`password`) — there is no `root` fallback
   - The configured database doesn't exist — set `createDatabaseIfMissing: true` only for a genuinely new environment
   - A pending migration fails validation, or (MariaDB) has no `-- +migrate Up` section
   - `R__*` files in a DDL `migrationsDir` don't stop anything — they're ignored with a warning; put them in a DCL project
   - Right before executing: a transaction open longer than `runtimeGates.longTransactionSec` (60s) or a session waiting on a metadata lock in the same database (`--allow-open-transactions` to proceed anyway), or a read-only target (no override). Without the `PROCESS` privilege (MariaDB) / `clusterMonitor` (MongoDB) the transaction check is skipped with a notice — or, with `runtimeGates.requireLockCheck: true` (recommended for production), the run is refused until the privilege is granted
   - Warned about, never stopped: (MongoDB) a pending migration that builds an index or runs `updateMany`/`deleteMany`/`bulkWrite` on a collection with `runtimeGates.largeCollectionDocs` (1,000,000) documents or more — the warning says which time limit applies to that file, or that none does; (MariaDB) a pending migration that runs `ALTER TABLE`, `CREATE INDEX`, `OPTIMIZE TABLE`, `UPDATE` or `DELETE` on a table with `runtimeGates.largeTableRows` (1,000,000) rows or more

4. **`reset` only clears records, not data**:
   - Only deletes tracking records in changelog/checksum; does not run `down()` and does not touch the actual tables/collections
   - After a reset, running `up` will fail outright if the tables/collections already exist (without `IF NOT EXISTS`)
   - Defaults to dry-run; requires `--yes` to actually delete

---

## Example: Production Server Workflow (multiple DDL projects sharing one DCL)

```bash
# 1. Run DCL first (create users and permissions)
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/production-server/dcl/config.js

# 2. Batch validate all DDL
docker compose run --rm migrate validate-all --ddl-only /app/test-fixtures/mariadb/production-server

# 3. Run each database's DDL
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/analytics/config.js
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/ecommerce/config.js
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/logging/config.js

# 4. Comprehensive testing (all databases)
docker compose run --rm migrate test-all \
  --pattern "test-fixtures/mariadb/production-server/ddl/**/config.js" \
  -o /app/reports

# 5. Verify DCL idempotency
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

> **Path note**: container paths start with `/app/test-fixtures/`. The
> `migrationsDir: './migrations'` in `config.js` is relative and doesn't need to change.
