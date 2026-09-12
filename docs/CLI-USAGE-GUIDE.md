# Database Migration Operations Guide

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
docker compose -f docker-compose.local-test.yml up -d mongodb mariadb

# Check status
docker compose -f docker-compose.local-test.yml ps

# View logs
docker compose -f docker-compose.local-test.yml logs -f
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
   - All instances share the same migration files
   - Each instance has its own changelog table

4. **`reset` only clears records, not data**:
   - Only deletes tracking records in changelog/checksum; does not run `down()` and does not touch the actual tables/collections
   - After a reset, running `up` will fail outright if the tables/collections already exist (without `IF NOT EXISTS`)
   - Defaults to dry-run; requires `--yes` to actually delete
