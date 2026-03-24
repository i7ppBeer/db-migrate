# DB-Migrate v2.1

> Unified multi-database migration management tool supporting MongoDB and MariaDB/MySQL with multi-instance sync testing, DDL versioned migrations, and DCL repeatable mode

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](package.json)

## 🎯 Features

- **Multi-Database Support**: MongoDB (via migrate-mongo) and MariaDB/MySQL (sql-migrate mode)
- **Multi-Instance Support**: Manage multiple database instances simultaneously (e.g., primary/secondary/tertiary)
- **Dual Migration Modes**: 
  - **Versioned (DDL)**: Timestamp-based versioning with up/down migrations
  - **Repeatable (DCL)**: Checksum-driven, auto-detect changes and re-execute
- **Unified CLI**: Single command-line interface for all database migrations
- **Validation Rules**: Auto-detect dangerous operations, empty down(), orphaned drops, DCL operations, etc.
  - **SQL Syntax Check (MariaDB)**: All `.sql` files are pre-validated by `node-sql-parser` (MariaDB dialect) before rule checks — syntax errors are caught early
  - **Smart Allowance**: CREATE DATABASE allowed in UP, DROP DATABASE allowed in DOWN (when UP creates it)
  - **Batch Validation**: `validate-all` command validates entire directory of DDL + DCL at once
- **Auto Database Creation**: MariaDB adapter auto-creates database before connection (dual guarantee)
- **Up-Down-Up Testing**: Ensure migrations can rollback and re-apply correctly
- **DCL Idempotency Verification**: Auto-verify DCL scripts produce same results on multiple executions
- **DCL Auto-Generated Passwords**: Each `CHANGE_ME_ON_FIRST_LOGIN` placeholder is replaced at runtime with its **own** cryptographically secure 16-character password — multiple accounts in one file each receive a unique password. Original files are never modified; credentials are saved to `/tmp/secret` (new accounts only) and never printed to the console. MongoDB new accounts also receive `customData` with expiry metadata.
- **Sanity Check**: Built-in Pre-Check / Post-Check / Auto-Rollback mechanism
- **Report Generation**: Support JSON and HTML formats
- **Containerized**: Docker and Kubernetes (Helm) deployment support

---

## 📦 Installation

```bash
# Clone repository
git clone https://github.com/your-org/db-migrate.git
cd db-migrate

# Install dependencies
npm install

# Link CLI globally (optional)
npm link
```

---

## 🚀 Quick Start

### 1. Start Test Databases

```bash
# Start MongoDB and MariaDB
docker compose up -d mongodb mariadb

# Verify services are running
docker compose ps
```

### 2. Run Example Migrations

```bash
# MongoDB example - check status
node src/cli.js -c databases/mongodb/test-success/ddl/config.js status

# MongoDB example - run migrations
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up

# MariaDB example - check status
node src/cli.js -c databases/mariadb/test-success/ddl/config.js status

# MariaDB example - run migrations
node src/cli.js -c databases/mariadb/test-success/ddl/config.js up
```

---

## 📖 Usage Guide

### Config Defaults & Delta Pattern

`loadConfig()` automatically loads a built-in defaults file (from `src/config-defaults/`) based on `type` + `mode`, then **deep-merges the user config on top**. This means your `config.js` only needs to export the fields that differ from the defaults — the rest are inherited.

| `type` | `mode` | Defaults file |
|--------|--------|---------------|
| `mariadb` | `versioned` (DDL) | `src/config-defaults/mariadb-ddl.js` |
| `mariadb` | `repeatable` (DCL) | `src/config-defaults/mariadb-dcl.js` |
| `mongodb` | `versioned` (DDL) | `src/config-defaults/mongodb-ddl.js` |
| `mongodb` | `repeatable` (DCL) | `src/config-defaults/mongodb-dcl.js` |

Environment variable defaults (from the built-in defaults files):

| Variable | Default | Used by |
|---|---|---|
| `MARIADB_HOST` | `localhost` | MariaDB host |
| `MARIADB_PORT` | `3306` | MariaDB port |
| `MARIADB_USER` | `root` | MariaDB user |
| `MARIADB_PASSWORD` | `rootpass` | MariaDB password |
| `MONGODB_URL` / `MONGODB_URI` | `mongodb://localhost:27017` | MongoDB connection URL |

### Basic Configuration Format

**MongoDB DDL Config** (`config.js`) — delta only:
```javascript
// Only override what differs from src/config-defaults/mongodb-ddl.js
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGO_DB || 'myapp' }
};
```

**MongoDB DCL Config** (`config.js`) — delta only:
```javascript
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },   // DCL default is already 'admin'; override if needed
  checksumCollection: '_dcl_migrations'
};
```

**MariaDB DDL Config** (`config.js`) — delta only:
```javascript
// host/port/user/password come from env vars (MARIADB_HOST etc.) or defaults
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
```

**MariaDB DCL Config** (`config.js`) — delta only:
```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',                  // DCL default; override if using a different DB
  checksumTable: '_dcl_migrations'
};
```

> **Deep merge**: Top-level keys (`sanityCheck`, `idempotencyCheck`, `mongodb`, `mariadb`) are merged one level deep, so you only need to specify the nested fields you want to override.

**Multi-Instance Config - MongoDB** (`config.js`):
```javascript
export default {
  type: 'mongodb',
  migrationsDir: './migrations',  // Shared migration directory
  
  instances: [
    {
      name: 'mongo-primary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_primary'
      },
      changelogCollection: 'changelog'
    },
    {
      name: 'mongo-secondary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_secondary'
      },
      changelogCollection: 'changelog'
    }
  ]
};
```

**Multi-Instance Config - MariaDB/MySQL** (`config.js`):
```javascript
export default {
  type: 'mariadb',
  migrationsDir: './migrations',  // Shared migration directory
  
  instances: [
    {
      name: 'mariadb-primary',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_primary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    },
    {
      name: 'mariadb-secondary',
      mariadb: {
        host: 'localhost',
        port: 3307,
        database: 'app_secondary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    }
  ]
};
```

---

### 📦 Docker Compose Method (Recommended, No Local Node.js Required)

> Execute all CLI commands via Docker Container without installing Node.js locally.

#### Environment Setup

```bash
# Start databases
docker compose up -d mongodb mariadb

# First-time use requires building migrate service
docker compose build migrate
```

**Command Format**:
```bash
docker compose run --rm migrate <command> [options] -c /app/databases/<db-type>/<project>/config.js
```

> **📝 Note about Examples**:  
> Examples below use `{{ namespace }}` as a placeholder. Replace it with actual directory names:
> - `{{ namespace }}` → `production-server` (multi-DB example in this repo)
> - Or use `test-success`, `test-failure`, `multi-instance` for testing

---

#### Basic Commands

**Check Status** (`status`):
```bash
docker compose run --rm migrate status -c /app/databases/mariadb/test-success/ddl/config.js
```

**Run Migrations** (`up`):
```bash
# Run all pending migrations
docker compose run --rm migrate up -c /app/databases/mariadb/test-success/ddl/config.js

# Dry run preview
docker compose run --rm migrate up --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# Enable Sanity Check
docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/test-success/ddl/config.js
```

**Rollback Migrations** (`down`):
```bash
# Rollback last 1 migration
docker compose run --rm migrate down -n 1 -c /app/databases/mariadb/test-success/ddl/config.js

# Rollback last 3 migrations
docker compose run --rm migrate down -n 3 -c /app/databases/mariadb/test-success/ddl/config.js
```

**Create Migration Files** (`create` / `create-dcl`):
```bash
# Create DDL migration
docker compose run --rm migrate create add-orders-table -c /app/databases/mariadb/test-success/ddl/config.js

# Create DCL migration (replace {{ namespace }} with production-server, etc.)
docker compose run --rm migrate create-dcl readonly_users -c /app/databases/mariadb/production-server/dcl/config.js

# Specify sequence number
docker compose run --rm migrate create-dcl app_service -n 004 -c /app/databases/mariadb/production-server/dcl/config.js
```

**Validate Migrations** (`validate`):
```bash
# Strict validation
docker compose run --rm migrate validate -c /app/databases/mariadb/test-success/ddl/config.js

# Allow dangerous operations
docker compose run --rm migrate validate --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js

# Allow specific operations
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/databases/mariadb/test-success/ddl/config.js
```

**Batch Validation** (`validate-all`):
```bash
# Validate entire directory's DDL + DCL
# Replace {{ namespace }} with actual directory: production-server, test-success, etc.
docker compose run --rm migrate validate-all /app/databases/mariadb/production-server

# Validate DDL only (no database connection required)
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/production-server

# Validate DCL only (database connection required)
docker compose run --rm migrate validate-all --dcl-only /app/databases/mariadb/production-server
```

**Baseline Existing Migrations** (`baseline`):
```bash
# Baseline all (Dry Run)
docker compose run --rm migrate baseline --all --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# Actual baseline
docker compose run --rm migrate baseline --all -c /app/databases/mariadb/test-success/ddl/config.js

# Baseline to specific version
docker compose run --rm migrate baseline --up-to 20250101000003-create-products.sql -c /app/databases/mariadb/test-success/ddl/config.js
```

**Up-Down-Up Test** (`test`):
```bash
docker compose run --rm migrate test -c /app/databases/mariadb/test-success/ddl/config.js
```

---

#### DCL Commands

**Run DCL Migrations** (`dcl`):
```bash
# Replace {{ namespace }} with actual directory name
docker compose run --rm migrate dcl -c /app/databases/mariadb/production-server/dcl/config.js

# Dry Run
docker compose run --rm migrate dcl --dry-run -c /app/databases/mariadb/production-server/dcl/config.js
```

**Check DCL Status** (`dcl:status`):
```bash
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/production-server/dcl/config.js
```

**Verify DCL Idempotency** (`dcl:verify`):
```bash
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/production-server/dcl/config.js
```

---

#### DCL Auto-Generated Passwords

DCL template files (`R__*.sql` / `R__*.js`) may contain the literal placeholder `CHANGE_ME_ON_FIRST_LOGIN`.
When the runner encounters this placeholder it **automatically generates a secure password at runtime** — no manual editing required.

**Each occurrence gets its own unique password.** A file that creates two accounts will produce two completely different passwords.

**How it works:**

| | Detail |
|---|---|
| File on disk | Always unchanged — still contains `CHANGE_ME_ON_FIRST_LOGIN` |
| Checksum | Computed from the original file (rotation does **not** trigger re-run) |
| Substitution | In-memory only, immediately before the SQL/JS is sent to the DB |
| Per-occurrence | Each `CHANGE_ME_ON_FIRST_LOGIN` → independently generated password |
| Password in console | **Not shown** — only a brief notice is printed |
| Password on disk | Appended to `/tmp/secret` (format: `username=password`, one per line) |

**Password rules:** 16 characters · a-z · A-Z · 0-9 · 1-2 special chars (`-` or `~`)  
Special chars are safe across MySQL/MariaDB CLI, `mongosh`, MongoDB URI, Bash, and ProxySQL.

**`/tmp/secret` file format** — positionally paired, accounts in declaration order:
```
app_readonly=6U3uELfN6alX0~CJ
app_readwrite=9kP2mQrX7sZa1-NW
```

> `/tmp/secret` is append-only. Manage or rotate it according to your security policy.  
> In Kubernetes / Docker, mount a secured volume to `/tmp` or copy `/tmp/secret` out before the pod terminates.

**Example console output when running `dcl`:**

```
[DCL] Auto-generated password for: R__004_secret_users.sql
  📝 [DCL] Credentials saved to /tmp/secret: app_readonly, app_readwrite
```

**Already-existing accounts are skipped** (MariaDB pre-checks `mysql.user` before executing SQL / MongoDB `return { passwordSet: false }`):
```
[DCL] Auto-generated password for: R__004_secret_users.sql
  ⚠️  [DCL] Account already existed — password NOT changed. Skipped /tmp/secret: app_readonly, app_readwrite
```

| Scenario | `/tmp/secret` | Console |
|---|---|---|
| New account(s) | Appended | `📝 Credentials saved` |
| Account(s) already exist | NOT written | `⚠️ Account already existed — Skipped` |
| `ALTER USER` (forced rotation) | Always appended | `📝 Credentials saved` |

**MariaDB — multiple accounts, each with a unique password** (`R__004_secret_users.sql`):
```sql
-- Each CHANGE_ME_ON_FIRST_LOGIN is replaced with a different password at runtime
CREATE USER IF NOT EXISTS 'app_readonly'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
CREATE USER IF NOT EXISTS 'app_readwrite'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite'@'%';
FLUSH PRIVILEGES;
```

**MariaDB — forced password rotation** (`R__005_rotate_passwords.sql`):
```sql
-- ALTER USER does not emit Note 1973, so every run writes a fresh password
ALTER USER 'app_readonly'@'%'  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
ALTER USER 'app_readwrite'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
FLUSH PRIVILEGES;
```

**MongoDB — each user object carries its own placeholder** (`R__003_secret_users.js`):
```javascript
// Each entry in the users array has its own CHANGE_ME_ON_FIRST_LOGIN.
// The runner replaces them independently before the module is executed.
const users = [
  { username: 'app_readonly',  password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
  { username: 'app_readwrite', password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
];

for (const u of users) {
  const exists = (await adminDb.command({ usersInfo: u.username })).users.length > 0;
  if (!exists) {
    await adminDb.command({ createUser: u.username, pwd: u.password, roles: u.roles });
    createdUsernames.push(u.username);
  } else {
    await adminDb.command({ updateUser: u.username, roles: u.roles });
  }
}
return { passwordSet: createdUsernames.length > 0, createdUsernames, allUsernames };
```

**MongoDB `customData` injection:**  
When a MongoDB DCL migration returns `{ passwordSet: true }`, the runner automatically calls `updateUser` to inject `customData` on every newly-created account:

```json
{
  "expiresAt": "<now + DCL_PASSWORD_EXPIRY_DAYS days>",
  "passwordLastModified": "<now>",
  "description": "Auto-created user, requires password change before expiry."
}
```

Set `DCL_PASSWORD_EXPIRY_DAYS` (default `7`) to control the expiry window.

---

#### Multi-Instance Commands

**Check All Instances Status** (`status-all`):
```bash
docker compose run --rm migrate status-all -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**Run All Instances Migrations** (`up-all`):
```bash
docker compose run --rm migrate up-all -c /app/databases/mariadb/multi-instance/ddl/config.js

# Dry Run
docker compose run --rm migrate up-all --dry-run -c /app/databases/mariadb/multi-instance/ddl/config.js

# Parallel execution
docker compose run --rm migrate up-all --parallel -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**Test All Instances** (`test-instances`):
```bash
docker compose run --rm migrate test-instances -c /app/databases/mariadb/multi-instance/ddl/config.js

# Validate only (skip Up-Down-Up)
docker compose run --rm migrate test-instances --validate-only -c /app/databases/mariadb/multi-instance/ddl/config.js

# Parallel execution
docker compose run --rm migrate test-instances --parallel -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**Test All Projects** (`test-all`):

The `test-all` command automatically handles DCL and DDL migrations differently:
- **DCL configs**: Validates + runs 3 times to verify idempotency
- **DDL configs**: Validates + runs Up-Down-Up test to verify rollback

```bash
# Test all projects in workspace
docker compose run --rm migrate test-all -o /app/reports

# Test specific namespace (replace {{ namespace }} with production-server, etc.)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/production-server/**/config.js" \
  -o /app/reports

# Test only DDL configs (exclude DCL)
docker compose run --rm migrate test-all \
  --pattern "databases/**/ddl/**/config.js" \
  -o /app/reports

# Test only DCL config (idempotency verification)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/production-server/dcl/config.js" \
  -o /app/reports

# Test specific database type
docker compose run --rm migrate test-all \
  --pattern "databases/mongodb/**/config.js" \
  -o /app/reports

# Console output only (do not save report files)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  --console-only
```

**Multi-Instance DCL** (`dcl-all` / `dcl:status-all` / `dcl:verify-all`):
```bash
# Run DCL on all instances
docker compose run --rm migrate dcl-all -c /app/databases/mariadb/multi-instance/dcl/config.js

# Check DCL status on all instances
docker compose run --rm migrate dcl:status-all -c /app/databases/mariadb/multi-instance/dcl/config.js

# Verify DCL idempotency on all instances
docker compose run --rm migrate dcl:verify-all -c /app/databases/mariadb/multi-instance/dcl/config.js
```

---

**Path Notes**:
- Container paths always start with `/app/databases/`
- `migrationsDir: './migrations'` in `config.js` is a relative path, no change needed

---

### 💻 Local Node.js Method

> After installing Node.js 20+ locally, you can execute CLI directly.

#### Command Format

```bash
node src/cli.js <command> [options] -c <config-path>
```

#### Common Command Examples

```bash
# Check status
node src/cli.js status -c databases/mariadb/test-success/ddl/config.js

# Run migrations
node src/cli.js up -c databases/mariadb/test-success/ddl/config.js

# Validate migrations
node src/cli.js validate -c databases/mariadb/test-success/ddl/config.js

# Batch validate
node src/cli.js validate-all databases/mariadb/production-server

# Run DCL
node src/cli.js dcl -c databases/mariadb/production-server/dcl/config.js

# Up-Down-Up test
node src/cli.js test -c databases/mariadb/test-success/ddl/config.js

# Test all databases in production-server
node src/cli.js test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  -o ./reports

# Console output only (do not save files)
node src/cli.js test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  --console-only

# Multi-instance operations
node src/cli.js status-all -c databases/mariadb/multi-instance/ddl/config.js
node src/cli.js up-all -c databases/mariadb/multi-instance/ddl/config.js
```

**Full Command List**: Refer to Docker Compose method above, replace `docker compose run --rm migrate` with `node src/cli.js`, and remove `/app/` prefix from paths.

---

### 🛡️ Dangerous Operations Allowance Mechanism

Validation tool auto-detects dangerous operations and provides allowance mechanism:

#### Three-Level Classification System

| Level | Symbol | Description | Allowance Method |
|-------|--------|-------------|------------------|
| **🔴 Forbidden** | ❌ | Absolutely prohibited, causes severe consequences | `--allow-forbidden` + team approval |
| **🟠 Dangerous** | ⚠️ | Dangerous operations, requires careful evaluation | `--allow-dangerous` |
| **⚪ Warning** | 💡 | Warning message, does not block execution | No allowance needed |

#### 🔴 Forbidden Operations (MariaDB)

| Operation | Description | Smart Allowance |
|-----------|-------------|-----------------|
| `DROP DATABASE` | Delete entire database | ✅ Allowed in DOWN (when UP has CREATE DATABASE) |
| `DROP SCHEMA` | Delete schema | ✅ Allowed in DOWN (when UP has CREATE) |
| `CREATE USER` | User management (should be in DCL) | - |
| `DROP USER` | User management (should be in DCL) | - |
| `GRANT` | Permission management (should be in DCL) | - |
| `REVOKE` | Permission management (should be in DCL) | - |

#### 🔴 Forbidden Operations (MongoDB)

| Operation | Description | Smart Allowance |
|-----------|-------------|-----------------|
| `dropDatabase()` | Delete database | ✅ Allowed in `down()` (when `up()` initializes) |
| `createUser()` | User management (should be in DCL) | - |
| `dropUser()` | User management (should be in DCL) | - |
| `grantRolesToUser()` | Permission management (should be in DCL) | - |

#### 🟠 Dangerous Operations (MariaDB)

- `TRUNCATE TABLE` - Clear table data
- `DROP INDEX` - Delete index (affects performance)
- `DROP COLUMN` - Delete column (data loss)
- `ALTER TABLE ... DROP FOREIGN KEY` - Remove foreign key constraint

#### 🟠 Dangerous Operations (MongoDB)

- `collection.drop()` - Delete collection
- `deleteMany({})` - Unconditional delete (affects data)
- `dropIndex()` - Delete index (affects performance)

#### Allowance Examples

```bash
# Allow all dangerous operations
docker compose run --rm migrate validate --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js

# Allow specific operations
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/databases/mariadb/test-success/ddl/config.js

# Allow forbidden operations (requires team approval)
docker compose run --rm migrate validate --allow-forbidden -c /app/databases/mariadb/test-success/ddl/config.js

# Same allowance options needed during execution
docker compose run --rm migrate up --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js
```

#### Per-File Annotation (Recommended)

Instead of CLI flags (which affect all files in a run), you can embed allowance directly in the migration file. This keeps the approval traceable in code review.

Annotations must appear **before the first non-comment line** of the file:

```sql
-- @allow-dangerous: true
-- Approved: DROP COLUMN old_field, deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;

-- +migrate Down
ALTER TABLE users ADD COLUMN old_field VARCHAR(255) NULL;
```

Allow only specific operation codes (stricter, preferred):

```sql
-- @allow: DROP_COLUMN

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

Allow forbidden operations (requires team approval):

```sql
-- @allow-forbidden: true

-- +migrate Up
DROP DATABASE legacy_db;
```

Multiple codes can be combined:

```sql
-- @allow: TRUNCATE_TABLE,DELETE_ALL

-- +migrate Up
TRUNCATE TABLE audit_log;
DELETE FROM temp_cache;
```

| Annotation | Scope | Equivalent CLI Flag |
|---|---|---|
| `-- @allow-dangerous: true` | All 🟠 dangerous ops in this file | `--allow-dangerous` |
| `-- @allow-forbidden: true` | All 🔴 forbidden ops in this file | `--allow-forbidden` |
| `-- @allow: CODE1,CODE2` | Only the listed operation codes | `--allow CODE1,CODE2` |

> ⚠️ Annotations affect only the file they are written in. CLI flags affect all files in the run.

#### CI/CD Integration

```yaml
# .gitlab-ci.yml example
validate-migrations:
  script:
    - docker compose run --rm migrate validate -c /app/databases/mariadb/production/ddl/config.js
    # If approved dangerous operations exist
    - docker compose run --rm migrate validate --allow TRUNCATE_TABLE -c /app/databases/mariadb/maintenance/ddl/config.js
  
run-migrations:
  script:
    - docker compose run --rm migrate up -c /app/databases/mariadb/production/ddl/config.js
  when: manual  # Requires manual trigger
```

#### Team Approval Process Recommendations

1. **Development Phase**: Strict validation, no dangerous operations allowed
2. **Code Review**: Extra approval required if dangerous operations exist
3. **Pre-Deployment**: Re-validate, confirm allowance options are correct
4. **Production**: Execute dangerous operations only during maintenance windows

---

### 🔷 DDL vs DCL Directory Structure

```
databases/
├── mariadb/
│   ├── _templates/                       # New project template
│   │   ├── dcl/
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── ddl/
│   │       ├── config.js
│   │       └── migrations/
│   ├── multi-instance/                    # Multi-instance config (same schema → multiple DBs)
│   │   ├── dcl/
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── ddl/
│   │       ├── config.js
│   │       └── migrations/
│   ├── production-server/                 # Production example (multiple DBs with different schemas)
│   │   ├── dcl/                           # DCL - Repeatable mode (Platform Team)
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   │       ├── R__01_readonly_users.sql
│   │   │       ├── R__02_readwrite_users.sql
│   │   │       └── R__03_ddl_admin.sql
│   │   └── ddl/                           # DDL - Versioned mode (Dev Team)
│   │       ├── ecommerce/
│   │       │   ├── config.js
│   │       │   └── migrations/
│   │       │       ├── 20260101000000-create-database.sql
│   │       │       ├── 20260101000001-create-users.sql
│   │       │       └── 20260101000002-create-products.sql
│   │       ├── analytics/
│   │       │   ├── config.js
│   │       │   └── migrations/
│   │       │       ├── 20260101000000-create-database.sql
│   │       │       ├── 20260101000001-create-events.sql
│   │       │       └── 20260101000002-create-daily-stats.sql
│   │       └── logging/
│   │           ├── config.js
│   │           └── migrations/
│   │               ├── 20260101000000-create-database.sql
│   │               ├── 20260101000001-create-app-logs.sql
│   │               └── 20260101000002-create-audit-trail.sql
│   ├── test-success/
│   └── test-failure/
└── mongodb/
    ├── multi-instance/
    │   ├── dcl/
    │   └── ddl/
    └── production-server/                 # Production example
        ├── dcl/
        │   ├── config.js
        │   └── migrations/
        └── ddl/
            └── ecommerce/
                ├── config.js
                └── migrations/
                    ├── 20260101000000-init-database.js
                    ├── 20260101000001-create-users.js
                    └── 20260101000002-create-products.js
```

**Description**:
- **DDL (Data Definition Language)**: Schema changes, uses Versioned mode (timestamp)
- **DCL (Data Control Language)**: Permission management, uses Repeatable mode (Checksum)
- **production-server**: Example directory demonstrating multi-database management
- **{{ namespace }}**: Demonstrates multi-database management, each database has independent directory
- **First migration**: Recommended to be `20260101000000-create-database.sql` (CREATE DATABASE)

---

### � MariaDB DCL — accounts.yaml 使用指南 (gen-dcl.py)

`tools/gen-dcl.py` 讀取 `accounts.yaml`，自動產生可直接套用的 DCL SQL 檔案。

#### 執行方式

```bash
python3 tools/gen-dcl.py databases/mariadb/<env>/dcl/accounts.yaml
# 指定輸出目錄
python3 tools/gen-dcl.py databases/mariadb/<env>/dcl/accounts.yaml -o /tmp/dcl-out
```

#### 欄位說明

| 欄位 | 必填 | 預設值 | 高風險獨立檔 | 說明 |
|------|:----:|--------|:------------:|------|
| `account` | ✅ | — | — | MariaDB User 名稱，host 固定為 `%` |
| `description` | ✅ | — | — | 人類可讀說明，不影響 SQL |
| `grants` | ✅ | — | — | 授權清單，至少一筆 |
| `alter` | ❌ | 全 0（無限制） | — | 資源限制 key/value |
| `revoke` | ❌ | 不撤銷 | ✅ | 撤銷已授予的權限 |
| `drop_user` | ❌ | `false` | ✅ | 刪除帳號 |
| `reset_pwd` | ❌ | `false` | ✅ | 強制密碼輪換 |

> ⚠️ **高風險欄位**（`revoke` / `drop_user` / `reset_pwd`）會獨立產生 `R__<YYYYMMDD>_<op>_<account>.sql` 並自動標記 `@allow-forbidden: true`，需由平台團隊審核後另行套用。

#### 完整範例

```yaml
accounts:

  - account: shop_api                  # ⬅ 必填｜User 名稱
    description: "Shop API Service"    # ⬅ 必填｜說明

    # grants — 必填，至少一筆
    grants:
      - privileges: [SELECT, INSERT, UPDATE, DELETE]
        on: ecommerce.*        # db.*  = 整個資料庫
      - privileges: [SELECT]
        on: analytics.events   # db.table = 單一資料表

    # alter — 選填，不填 = 全部 0 (無限制)
    alter:
      MAX_QUERIES_PER_HOUR: 2000      # 每小時查詢上限   (0 = 無限制)
      MAX_UPDATES_PER_HOUR: 0         # 每小時寫入上限   (0 = 無限制)
      MAX_CONNECTIONS_PER_HOUR: 0     # 每小時連線建立上限
      MAX_USER_CONNECTIONS: 10        # 同時連線上限

    # reset_pwd — 選填，預設 false ⚠️ 高風險
    reset_pwd: true   # → ALTER USER ... IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'

  - account: shop_ddl
    description: "Shop DDL Admin"
    grants:
      - privileges: [SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX]
        on: ecommerce.*
    alter:
      MAX_USER_CONNECTIONS: 3

    # revoke — 選填，不填 = 不撤銷 ⚠️ 高風險
    # 若帳號原本無此權限，CONTINUE HANDLER FOR 1141 自動跳過不報錯
    revoke:
      - privileges: [DROP, ALTER]
        on: ecommerce.*

    # drop_user — 選填，預設 false ⚠️ 高風險
    drop_user: true   # → DROP USER IF EXISTS 'shop_ddl'@'%'
```

#### grants.privileges 可用值（MariaDB 10.6）

```
SELECT  INSERT  UPDATE  DELETE
CREATE  ALTER   DROP    INDEX
CREATE VIEW  SHOW VIEW
EXECUTE  TRIGGER  EVENT
REFERENCES  LOCK TABLES
```

#### 產生的檔案結構

```
<output_dir>/
├── R__01_<group>.sql                          # CREATE USER IF NOT EXISTS + GRANT（冪等）
├── R__02_<group>.sql                          # 同上，另一個帳號群組
├── R__<YYYYMMDD>_revoke_<account>.sql        # ⚠️ 高風險：REVOKE（含 CONTINUE HANDLER）
├── R__<YYYYMMDD>_reset_pwd_<account>.sql     # ⚠️ 高風險：ALTER USER IDENTIFIED BY
└── R__<YYYYMMDD>_drop_user_<account>.sql     # ⚠️ 高風險：DROP USER IF EXISTS
```

---

### �🔷 Practical Examples

#### Development Workflow

```bash
# 1. Start databases
docker compose up -d mongodb mariadb

# 2. Create new migration
docker compose run --rm migrate create add-user-roles -c /app/databases/mongodb/test-success/ddl/config.js

# 3. Edit migration file (implement up/down functions)
# vim databases/mongodb/test-success/ddl/migrations/20260211XXXXXX-add-user-roles.js

# 4. Validate migration
docker compose run --rm migrate validate -c /app/databases/mongodb/test-success/ddl/config.js

# 5. Run migration (dry-run first)
docker compose run --rm migrate up --dry-run -c /app/databases/mongodb/test-success/ddl/config.js

# 6. Actual execution
docker compose run --rm migrate up -c /app/databases/mongodb/test-success/ddl/config.js

# 7. Test rollback
docker compose run --rm migrate test -c /app/databases/mongodb/test-success/ddl/config.js
```

#### Production Server Workflow

Example using `production-server` directory (contains 3 databases: analytics, ecommerce, logging):

```bash
# 1. Run DCL first (create users and permissions)
docker compose run --rm migrate dcl -c /app/databases/mariadb/production-server/dcl/config.js

# 2. Batch validate all DDL
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/production-server

# 3. Run each database's DDL
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/analytics/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/ecommerce/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/logging/config.js

# 4. Comprehensive testing (all databases)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  -o /app/reports

# 5. Verify DCL idempotency
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/production-server/dcl/config.js

# 6. View test report
# Open reports/test-report-*.html in browser
```

#### CI/CD Integration

```bash
# Validate all migrations in CI pipeline
docker compose run --rm migrate validate -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# Run complete test
docker compose run --rm migrate test -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# Batch validate production-server
docker compose run --rm migrate validate-all /app/databases/mariadb/production-server || exit 1

# Test all databases in production-server (Up-Down-Up)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  -o /app/reports || exit 1

# Run migrations during deployment
docker compose run --rm migrate up -c /app/databases/mongodb/production/ddl/config.js
```

**GitLab CI Example**:
```yaml
# .gitlab-ci.yml
stages:
  - validate
  - test
  - deploy

validate-migrations:
  stage: validate
  script:
    # Validate all production-server DDL
    - docker compose run --rm migrate validate-all /app/databases/mariadb/production-server
  
test-migrations:
  stage: test
  script:
    # Run comprehensive tests on production-server
    - docker compose run --rm migrate test-all 
        --pattern "databases/mariadb/production-server/ddl/**/config.js"
        -o /app/reports
  artifacts:
    paths:
      - reports/
    when: always

deploy-production:
  stage: deploy
  script:
    # Run DCL first
    - docker compose run --rm migrate dcl -c /app/databases/mariadb/production-server/dcl/config.js
    # Run each database DDL
    - docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/analytics/config.js
    - docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/ecommerce/config.js
    - docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/logging/config.js
  when: manual
  only:
    - main
```

#### Multi-Environment Deployment

```bash
# Use environment variables to switch environments
MONGO_URL=mongodb://prod-server:27017 \
MONGO_DB=production_db \
docker compose run --rm migrate up -c /app/databases/mongodb/test-success/ddl/config.js

# Or create environment-specific configs
docker compose run --rm migrate status -c /app/databases/mongodb/production/config.js
docker compose run --rm migrate up -c /app/databases/mongodb/staging/config.js
```

---

## 📁 Project Structure

```
db-migrate/
├── src/
│   ├── cli.js                      # Unified CLI entry point
│   ├── check-db.js                  # Database availability check
│   ├── core/
│   │   ├── base-adapter.js         # Adapter base class
│   │   ├── reporter.js             # Report generator
│   │   ├── sanity-checker.js       # Sanity Check framework
│   │   ├── repeatable-runner.js    # DCL Repeatable migration executor
│   │   └── dcl-idempotent-checker.js # DCL idempotency verifier
│   ├── adapters/
│   │   ├── index.js                # Adapter factory + loadConfig auto-merge
│   │   ├── mongodb-adapter.js      # MongoDB adapter
│   │   └── mariadb-adapter.js      # MariaDB adapter
│   └── config-defaults/            # Built-in defaults per db/mode
│       ├── mariadb-dcl.js          # MariaDB DCL defaults (host/port/user/checksumTable/…)
│       ├── mariadb-ddl.js          # MariaDB DDL defaults (host/port/user/sanityCheck/…)
│       ├── mongodb-dcl.js          # MongoDB DCL defaults (url/checksumCollection/…)
│       └── mongodb-ddl.js          # MongoDB DDL defaults (url/changelogCollection/…)
├── databases/
│   ├── mongodb/
│   │   ├── _templates/             # New project template (dcl/ + ddl/)
│   │   ├── test-success/           # MongoDB success cases
│   │   ├── test-failure/           # MongoDB failure cases (for validation)
│   │   ├── multi-instance/         # Multi-instance config (dcl/ + ddl/)
│   │   └── production-server/      # Production server example
│   │       ├── dcl/                # DCL Repeatable migrations
│   │       └── ddl/                # DDL Versioned migrations
│   └── mariadb/
│       ├── _templates/             # New project template (dcl/ + ddl/)
│       ├── test-success/           # MariaDB success cases
│       ├── test-failure/           # MariaDB failure cases
│       ├── multi-instance/         # Multi-instance config (dcl/ + ddl/)
│       └── production-server/      # Production server (3 DBs: ecommerce/analytics/logging)
│           ├── dcl/                # DCL Repeatable migrations
│           └── ddl/                # DDL Versioned migrations (each DB has independent subdirectory)
├── charts/
│   └── db-migrate/                 # Helm Chart (includes ConfigMap multi-DB mode)
│       ├── templates/
│       │   ├── configmap.yaml      # One ConfigMap per DB (DDL+DCL merged)
│       │   ├── migration-jobs.yaml # DDL/DCL Jobs (one set per DB)
│       │   └── ...
│       ├── values.yaml             # Default values
│       └── values-multi-db.yaml    # Multi-DB example values
├── docker/
│   └── entrypoint.sh               # Docker/K8s entry script
├── scripts/
│   ├── gen-values.py               # Auto-generate Helm values.yaml from project directory
│   ├── build-migration-image.sh    # Build Migration Docker image
│   ├── ci-migration-test.sh        # CI migration test script
│   ├── full-migration-test.sh      # Complete migration test
│   ├── local-test.sh               # Local test script
│   ├── setup-k8s-dev.sh            # K8s development environment setup
│   └── run-tests.sh                # Test execution script
├── Dockerfile                      # Multi-stage Dockerfile
├── Dockerfile.migrations           # Migration image Dockerfile
└── docker-compose.yml              # Development environment Compose
```

---

## 🔧 Migration File Formats

### MongoDB (.js)

```javascript
// 20250101000001-create-users.js
export async function up(db, client) {
  // Create Collection and set Schema validation
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'name'],
        properties: {
          email: { bsonType: 'string', description: 'User email' },
          name: { bsonType: 'string' },
          createdAt: { bsonType: 'date' }
        }
      }
    }
  });
  
  // Create index
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### MongoDB with Sanity Check (.js)

```javascript
// 20250101000002-add-phone-field.js

/**
 * @sanity PreCheck
 * - EXPECT_NO_COLLECTION: users_backup
 */

// Up Migration
export const up = async (db, client) => {
  await db.collection('users').updateMany(
    {},
    { 
      $set: { 
        phone: null,
        phoneVerified: false 
      } 
    }
  );
  
  await db.collection('users').createIndex({ phone: 1 });
};

/**
 * @sanity PostCheck
 * - EXPECT_INDEX: users.phone_1
 * - EXPECT_FIELD: users.phone
 */

// Down Migration
export const down = async (db, client) => {
  await db.collection('users').dropIndex('phone_1');
  await db.collection('users').updateMany({}, { $unset: { phone: '', phoneVerified: '' } });
};
```

### MariaDB/MySQL (.sql)

**Important**: For new databases, the first migration should be CREATE DATABASE:

```sql
-- 20260101000000-create-database.sql

-- +migrate Up
CREATE DATABASE IF NOT EXISTS myapp
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- +migrate Down
-- ⚠️ WARNING: This will drop the entire database and all its data!
-- Only run this in development/testing environments
DROP DATABASE IF EXISTS myapp;
```

**Dual Guarantee Mechanism**:
1. **Adapter Auto-Create**: MariaDB adapter executes `CREATE DATABASE IF NOT EXISTS` before connection
2. **Explicit Migration**: First migration explicitly records database creation history

**Smart Allowance Rules**:
- ✅ `CREATE DATABASE` allowed in UP section
- ✅ `DROP DATABASE` allowed in DOWN section (when UP creates it)
- ❌ `DROP DATABASE` prohibited in UP section (prevent accidental deletion)

---

**General Table Structure Migration Example**:

```sql
-- 20250101000001-create-users.sql

-- +migrate Up
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_users_name ON users(name);

-- +migrate Down
DROP TABLE IF EXISTS users;
```

### MariaDB/MySQL with Sanity Check (.sql)

Sanity Check lets you attach **PreCheck** and **PostCheck** SQL queries to each migration. When `--sanity-check` is enabled, the execution flow becomes:

```
PreCheck → Execute Migration (Up) → PostCheck
   ↓ fail        ↓ fail               ↓ fail
  ABORT      Auto-Rollback (Down)   Auto-Rollback (Down)
```

#### Syntax

Use raw SQL directly — one `SELECT` per line. Each query must return **at least 1 row** to pass. Comments (lines starting with `--`) are ignored.

```
-- +sanity PreCheck      ← start of PreCheck block
<SQL queries>
-- +migrate Up           ← implicit end of PreCheck (next section marker)
```

```
-- +sanity PostCheck     ← start of PostCheck block
<SQL queries>
-- +migrate Down         ← implicit end of PostCheck (next section marker)
```

The boundary between sanity block and the next section is **implicit** — the next `-- +migrate` marker automatically closes the sanity block.

#### Full Example: Add Column with Sanity Check

```sql
-- 20260101000003-add-events-platform-columns.sql
-- @allow: ALTER_TABLE_ADD

-- +sanity PreCheck
-- 確認 events 表存在、platform 欄位尚未存在、country_code 欄位尚未存在
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events';
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='event_type';
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='platform');
-- +migrate Up
ALTER TABLE events
    ADD COLUMN platform VARCHAR(50) DEFAULT NULL AFTER user_agent,
    ADD COLUMN country_code CHAR(2) DEFAULT NULL AFTER platform;

CREATE INDEX idx_events_platform ON events(platform);

-- +sanity PostCheck
-- 確認新欄位和索引已成功建立
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='platform';
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='country_code';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_events_platform';
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='platform' AND COLUMN_TYPE='varchar(50)';
-- +migrate Down
DROP INDEX idx_events_platform ON events;
ALTER TABLE events
    DROP COLUMN country_code,
    DROP COLUMN platform;
```

#### Example: Extend Column Length

```sql
-- 20260101000004-extend-event-type-length.sql
-- @allow: ALTER_TABLE_MODIFY,MODIFY_COLUMN

-- +sanity PreCheck
-- 確認欄位目前為 VARCHAR(100)，防止重複執行
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='event_type' AND CHARACTER_MAXIMUM_LENGTH=100;
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND COLUMN_NAME='metric_name' AND CHARACTER_MAXIMUM_LENGTH=100;
-- +migrate Up
ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(200) NOT NULL;

ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(200) NOT NULL;

-- +sanity PostCheck
-- 確認兩個欄位已成功擴展為 VARCHAR(200)
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='event_type' AND CHARACTER_MAXIMUM_LENGTH=200;
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND COLUMN_NAME='metric_name' AND CHARACTER_MAXIMUM_LENGTH=200;
-- +migrate Down
ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(100) NOT NULL;

ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(100) NOT NULL;
```

#### Example: Create Database (PostCheck only)

```sql
-- 20260101000000-create-database.sql

-- +migrate Up
CREATE DATABASE IF NOT EXISTS analytics
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認資料庫成功建立
SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='analytics';
-- +migrate Down
DROP DATABASE IF EXISTS analytics;
```

> **Note**: PreCheck is omitted here because the adapter auto-creates the database before migrations run, making a NOT EXISTS check impossible to pass.

#### Execution Phases

When running `up --sanity-check`:

| Phase | Description | On Failure |
|---|---|---|
| **Phase 1: PreCheck** | Run PreCheck queries before migration | Abort — migration is **not** executed |
| **Phase 2: Execute** | Run the Up migration SQL | Auto-Rollback (execute Down section) |
| **Phase 3: PostCheck** | Run PostCheck queries after migration | Auto-Rollback (execute Down section) |

- Each sanity query must return **≥ 1 row** to pass
- If PostCheck fails, the Down section is executed automatically to restore the previous state
- If auto-rollback also fails, the error is reported and **manual intervention** is required

#### CLI Usage

```bash
# Run with sanity check enabled
node src/cli.js up --sanity-check -c config.js

# Docker
docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/production-server/ddl/analytics/config.js
```

#### SQL Syntax Validation for Sanity Blocks

The `validate` command checks SQL syntax in **all 4 sections**: PreCheck, Up, PostCheck, and Down.

```bash
node src/cli.js validate -c config.js
```

| Section | Error Code | Description |
|---|---|---|
| Up | `SQL_SYNTAX_ERROR` | Syntax error in Up migration SQL |
| Down | `SQL_SYNTAX_ERROR_DOWN` | Syntax error in Down rollback SQL |
| PreCheck / PostCheck | `SANITY_SQL_SYNTAX_ERROR` | Syntax error in sanity block SQL |

---

## ✅ Validation Rules

Automatically detect the following issues:

### MongoDB Validation Rules

| Category | Operation | Severity | Description |
|----------|-----------|----------|-------------|
| **Dangerous Ops** | `dropDatabase`, `dropAllUsers`, `dropAllRoles` | ❌ Error | `dropDatabase()` allowed in `down()` when `up()` initializes database |
| **DCL Ops** | `createUser`, `dropUser`, `updateUser` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **DCL Ops** | `createRole`, `dropRole`, `grantRolesToUser` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **DCL Ops** | `revokeRolesFromUser`, `shutdown` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **Empty down()** | up() has operations but down() is empty | ❌ Error | Must provide rollback logic |
| **Orphaned drop** | down() drops collections not created by up() | ❌ Error | Prevent accidental deletion of existing data |
| **Non-idempotent** | `deleteMany({})`, `drop()` without conditions | ⚠️ Warning | May affect DCL idempotency |

### MariaDB/MySQL Validation Rules

| Category | Operation | Severity | Description |
|----------|-----------|----------|-------------|
| **Dangerous Ops** | `DROP DATABASE`, `DROP SCHEMA` | ❌ Error | Prohibited in UP; allowed in DOWN (when UP has CREATE DATABASE) |
| **Safe Ops** | `CREATE DATABASE`, `CREATE SCHEMA` | ✅ Allowed | Allowed in UP; prohibited in DOWN (prevent accidental creation) |
| **Dangerous Ops** | `TRUNCATE TABLE` | ❌ Error | Requires `--allow-dangerous` allowance |
| **DCL Ops** | `CREATE USER`, `DROP USER`, `ALTER USER` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **DCL Ops** | `GRANT`, `REVOKE`, `SET PASSWORD` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **DCL Ops** | `FLUSH PRIVILEGES` | ⚠️ Warning | Should move to DCL repeatable migrations |
| **Data Export** | `INTO OUTFILE`, `LOAD DATA INFILE` | ⚠️ Warning | Potential security risk |
| **Empty Down** | Up has SQL but Down is empty | ❌ Error | Must provide rollback logic |
| **Orphaned drop** | Down drops tables not created by Up | ❌ Error | Prevent accidental deletion of existing data |

**Smart Allowance Logic**:
- `CREATE DATABASE` in UP section auto-allowed (for initialization)
- `DROP DATABASE` in DOWN section auto-allowed (when corresponding UP has CREATE DATABASE)
- `DROP DATABASE` in UP section always prohibited (prevent accidental deletion)
- MongoDB `dropDatabase()` in `down()` function auto-allowed (when `up()` initializes database)

---

## 🔍 SQL Syntax Pre-Validation (MariaDB)

Every `.sql` migration file goes through **`node-sql-parser`** (MariaDB dialect) as the **first** validation step — before any dangerous-op or structural rules run. This catches raw syntax mistakes early.

```
validate pipeline
  └─ Step 0: SQL syntax check (node-sql-parser, MariaDB dialect)
  └─ Step 1: forbidden / dangerous operation rules
  └─ Step 2: structural checks (orphan drops, empty DOWN, etc.)
  └─ Step 3: performance & suspicious-name checks
```

### What is checked

**All 4 sections** are extracted and parsed independently: PreCheck, Up, PostCheck, and Down. If no `-- +migrate Up` marker is present (e.g. R__ files), the full file content is used.

| Section | Error Code | Behaviour |
|---|---|---|
| Up (or full file for R__) | `SQL_SYNTAX_ERROR` | ❌ Validation fails |
| Down | `SQL_SYNTAX_ERROR_DOWN` | ❌ Validation fails |
| PreCheck / PostCheck | `SANITY_SQL_SYNTAX_ERROR` | ❌ Validation fails |
| File contains `DELIMITER` | — | ⚠️ Skipped with warning (per-section) |
| `-- @skip-syntax-check: true` | — | ⚠️ Skipped entirely |

### Unsupported syntax — DELIMITER (Stored Procedures)

`node-sql-parser` does **not** support MariaDB's `DELIMITER` syntax used in stored procedures / triggers. Files containing it are **automatically skipped** from syntax check and produce a warning instead of a false error:

```sql
-- +migrate Up
DELIMITER //
CREATE PROCEDURE my_proc()
BEGIN
  SELECT 1;
END //
DELIMITER ;
```

Output:
```
[OK] my-procedure.sql
   ⚠️  ⚠️ SQL syntax check skipped: DELIMITER syntax detected (stored procedure — not supported by parser)
```

The file still goes through all other validation rules (dangerous ops, structural checks, etc.); only the syntax check is skipped.

### Opt-out annotation

If you have other non-standard syntax that the parser doesn't handle (e.g. MariaDB-specific extensions), add the annotation at the **very top** of the file:

```sql
-- @skip-syntax-check: true
-- +migrate Up
-- your SQL here ...
```

> ⚠️ Use sparingly. Prefer fixing the syntax or using `DELIMITER` skip (automatic). This annotation bypasses syntax check entirely.

---

## 🧪 Testing

### Local Testing

```bash
# Start test databases
docker compose up -d mongodb mariadb

# Wait for databases to be ready
sleep 10

# Run validation tests
node src/cli.js -c databases/mongodb/test-success/ddl/config.js validate
node src/cli.js -c databases/mariadb/test-success/ddl/config.js validate

# Run dangerous operation detection tests (should fail)
node src/cli.js -c databases/mongodb/test-failure/ddl/config.js validate
node src/cli.js -c databases/mariadb/test-failure/ddl/config.js validate

# Run Up-Down-Up tests
node src/cli.js -c databases/mongodb/test-success/ddl/config.js test
node src/cli.js -c databases/mariadb/test-success/ddl/config.js test

# Run all tests and generate reports
node src/cli.js test-all -o ./reports

# Test specific namespace with pattern
node src/cli.js test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  -o ./reports

# Console output only (no file saving)
node src/cli.js test-all \
  --pattern "databases/mariadb/production-server/ddl/**/config.js" \
  --console-only
```

### Pattern Matching Examples

The `test-all` command supports glob patterns to selectively test databases. It automatically detects DCL vs DDL configs and applies appropriate testing:

```bash
# Test all configs in production-server (both DCL and DDL)
node src/cli.js test-all --pattern "databases/mariadb/production-server/**/config.js"

# Test only DDL configs in production-server
node src/cli.js test-all --pattern "databases/mariadb/production-server/ddl/**/config.js"

# Test only DCL config (runs 3x for idempotency)
node src/cli.js test-all --pattern "databases/mariadb/production-server/dcl/config.js"

# Test only analytics database
node src/cli.js test-all --pattern "databases/mariadb/production-server/ddl/analytics/config.js"

# Test all MongoDB databases
node src/cli.js test-all --pattern "databases/mongodb/**/ddl/config.js"

# Test all DDL configs across all databases
node src/cli.js test-all --pattern "databases/**/ddl/**/config.js"

# Test specific projects
node src/cli.js test-all --pattern "databases/**/test-success/*/config.js"
```

**Testing Behavior**:
- **DCL configs** (`/dcl/config.js`):
  1. Validate migrations exist
  2. Run migrations 3 times to verify idempotency
- **DDL configs** (`/ddl/**/config.js`): 
  1. Validate migrations (no dangerous operations)
  2. Run Up-Down-Up test to verify rollback

**Pattern Syntax**:
- `**` - Matches any number of directories (recursive)
- `*` - Matches any characters except `/` (single level)
- Paths are relative to `--base-dir` (or workspace root if not set)

**`--base-dir` Option**:

When your config files are stored outside the workspace (e.g. a mounted NFS/external volume), use `--base-dir` to set the search root. The `--pattern` is then treated as a path **relative to that directory**.

```bash
# Configs at: /mnt/configs/project/dcl/config.js
#              /mnt/configs/project/ddl/aaa/config.js
#              /mnt/configs/project/ddl/bbb/config.js

# Use --base-dir to point to the root, --pattern is relative
node src/cli.js test-all \
  --base-dir /mnt/configs \
  --pattern "project/**/config.js"

# Without --base-dir, pattern must be relative to cwd
node src/cli.js test-all \
  --pattern "databases/mariadb/project/**/config.js"
```

| Scenario | `--base-dir` | `--pattern` |
|---|---|---|
| Configs inside workspace | _(omit)_ | `databases/mariadb/demo/**/config.js` |
| Configs on external volume | `/mnt/configs` | `demo/**/config.js` |
| Namespace = single depth | `/mnt/configs` | `demo/*/config.js` |
| Namespace = nested depth | `/mnt/configs` | `demo/**/config.js` |

> **`*` vs `**`**: Use `*` when configs are exactly one level deep (`dcl/config.js`). Use `**` when configs may be nested at any depth (`ddl/aaa/config.js`, `ddl/bbb/config.js`).

**Output Options**:
- Default: Console output + JSON/HTML files in `./reports/`
- `--console-only`: Only console output, no file saving
- `-o <dir>`: Specify custom output directory for reports

### Using Test Scripts

```bash
# Run complete test suite
./scripts/run-tests.sh

# Use Docker
./scripts/run-tests.sh --docker
```

---

## 🐳 Docker Usage

### Build Images

```bash
# Build production image
docker build -t db-migrate:2.0.0 --target production .

# Build runner image (for CI/CD)
docker build -t db-migrate:2.0.0-runner --target runner .
```

### Docker Compose Usage

```bash
# Start complete environment (MongoDB + MariaDB)
docker compose up -d

# Check service status
docker compose ps

# Run MongoDB migrations
docker compose run --rm runner-mongodb up

# Run MariaDB migrations
docker compose run --rm runner-mariadb up

# Check status
docker compose run --rm runner-mongodb status

# Run tests
docker compose run --rm runner-mongodb test

# Run all tests and generate reports
docker compose run --rm test-all

# Stop all services
docker compose down

# Clean data
docker compose down -v
```

---

## ☸️ Kubernetes Deployment

### Install Development Environment

```bash
# Install k3d (lightweight Kubernetes)
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# Create local cluster
k3d cluster create dev-cluster

# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### Helm Chart Usage

#### MongoDB Deployment

```bash
# Install with MongoDB configuration
helm install db-migrate ./charts/db-migrate \
  --set migration.type=mongodb \
  --set mongodb.enabled=true \
  --set mongodb.url="mongodb://mongodb-svc:27017" \
  --set mongodb.database="myapp" \
  --set configMap.enabled=true \
  --set-file configMap.ddlFiles.20250101000001-create-users.js=databases/mongodb/test-success/ddl/migrations/20250101000001-create-users.js

# Check Job status
kubectl get jobs -w

# View migration logs
kubectl logs -l app=db-migrate
```

#### MariaDB Deployment

```bash
# Install with MariaDB configuration
helm install db-migrate ./charts/db-migrate \
  --set migration.type=mariadb \
  --set mariadb.enabled=true \
  --set mariadb.host="mariadb-svc" \
  --set mariadb.database="myapp" \
  --set mariadb.user="migrate" \
  --set mariadb.password="migratepass"
```

#### Enable Sanity Check

```bash
helm install db-migrate ./charts/db-migrate \
  --set migration.type=mariadb \
  --set migration.sanityCheck.enabled=true \
  --set migration.sanityCheck.autoRollback=true
```

#### Run Different Commands

```bash
# Run status command
helm install db-migrate ./charts/db-migrate \
  --set migration.command=status

# Run validate command
helm install db-migrate ./charts/db-migrate \
  --set migration.command=validate

# Run test command
helm install db-migrate ./charts/db-migrate \
  --set migration.command=test
```

#### Use ConfigMap to Load Migrations (Single DB Mode)

```bash
# Create ConfigMap from migration files
kubectl create configmap db-migrations \
  --from-file=databases/mariadb/test-success/ddl/migrations/

# Install with ConfigMap
helm install db-migrate ./charts/db-migrate \
  --set migration.type=mariadb \
  --set configMap.enabled=true \
  --set configMap.name=db-migrations
```

#### Multi-Database ConfigMap Mode (Recommended)

For complex scenarios like production-server with multiple databases (ecommerce/analytics/logging), use auto-generation script:

#### Use gen-values.py to Auto-Generate values

```bash
# Preview generated values
python3 scripts/gen-values.py databases/mariadb/production-server --dry-run

# Generate values.yaml file
python3 scripts/gen-values.py databases/mariadb/production-server \
  --output values-production-server.yaml \
  --namespace default \
  --mariadb-host mariadb-svc

# Deploy using generated values
helm install db-migrate ./charts/db-migrate -f values-production-server.yaml
```

---

## 📊 Reports

Test reports are generated in JSON and HTML formats:

```bash
# Generate report
node src/cli.js test-all -o ./reports

# Report files
./reports/
├── test-report.json    # JSON format
└── test-report.html    # HTML format (open in browser)
```

**HTML Report Contents**:
- Overall statistics (pass/fail count)
- Detailed migration information per database
- Validation error details
- Up-Down-Up test results

---

## 🔗 Related Documentation

- [CLI Usage Guide](docs/CLI-USAGE-GUIDE.md)
- [Migration Management Guide](docs/MIGRATION-MANAGEMENT-GUIDE.md)
- [Validation Rules Reference](docs/VALIDATION-RULES-REFERENCE.md)
- [Docker Compose User Guide](docs/DOCKER-COMPOSE-USER-GUIDE.md)
- [Local Test Guide](docs/LOCAL-TEST-GUIDE.md)
- [CI Migration Test Guide](docs/CI-MIGRATION-TEST-GUIDE.md)
- [Build Image Guide](docs/BUILD-IMAGE-GUIDE.md)
- [Existing Database Onboarding](docs/EXISTING-DATABASE-ONBOARDING.md)
- [Vault Boundary Guide](docs/VAULT-BOUNDARY-GUIDE.md)

---

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.
