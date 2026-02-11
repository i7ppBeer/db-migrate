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
  - **Smart Allowance**: CREATE DATABASE allowed in UP, DROP DATABASE allowed in DOWN (when UP creates it)
  - **Batch Validation**: `validate-all` command validates entire directory of DDL + DCL at once
- **Auto Database Creation**: MariaDB adapter auto-creates database before connection (dual guarantee)
- **Up-Down-Up Testing**: Ensure migrations can rollback and re-apply correctly
- **DCL Idempotency Verification**: Auto-verify DCL scripts produce same results on multiple executions
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

### Basic Configuration Format

**MongoDB Config** (`config.js`):
```javascript
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGO_URL || 'mongodb://localhost:27017',
    databaseName: process.env.MONGO_DB || 'myapp'
  },
  migrationsDir: './migrations',
  changelogCollection: 'changelog'
};
```

**MariaDB/MySQL Config** (`config.js`):
```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'myapp',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'
};
```

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

# Create DCL migration
docker compose run --rm migrate create-dcl readonly_users -c /app/databases/mariadb/{{ namespace }}/dcl/config.js

# Specify sequence number
docker compose run --rm migrate create-dcl app_service -n 004 -c /app/databases/mariadb/{{ namespace }}/dcl/config.js
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
docker compose run --rm migrate validate-all /app/databases/mariadb/{{ namespace }}

# Validate DDL only (no database connection required)
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/{{ namespace }}

# Validate DCL only (database connection required)
docker compose run --rm migrate validate-all --dcl-only /app/databases/mariadb/{{ namespace }}
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
docker compose run --rm migrate dcl -c /app/databases/mariadb/{{ namespace }}/dcl/config.js

# Dry Run
docker compose run --rm migrate dcl --dry-run -c /app/databases/mariadb/{{ namespace }}/dcl/config.js
```

**Check DCL Status** (`dcl:status`):
```bash
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/{{ namespace }}/dcl/config.js
```

**Verify DCL Idempotency** (`dcl:verify`):
```bash
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/{{ namespace }}/dcl/config.js
```

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
```bash
# Test all projects in workspace
docker compose run --rm migrate test-all -o /app/reports

# Test specific namespace (e.g., {{ namespace }})
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  -o /app/reports

# Test all DDL configs (exclude DCL)
docker compose run --rm migrate test-all \
  --pattern "databases/**/ddl/config.js" \
  -o /app/reports

# Test specific database type
docker compose run --rm migrate test-all \
  --pattern "databases/mongodb/**/config.js" \
  -o /app/reports

# Console output only (do not save report files)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
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
node src/cli.js validate-all databases/mariadb/{{ namespace }}

# Run DCL
node src/cli.js dcl -c databases/mariadb/{{ namespace }}/dcl/config.js

# Up-Down-Up test
node src/cli.js test -c databases/mariadb/test-success/ddl/config.js

# Test all databases in {{ namespace }}
node src/cli.js test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
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
│   ├── {{ namespace }}/                   # Production environment (multiple DBs with different schemas)
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
    └── {{ namespace }}/
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
- **{{ namespace }}**: Demonstrates multi-database management, each database has independent directory
- **First migration**: Recommended to be `20260101000000-create-database.sql` (CREATE DATABASE)

---

### 🔷 Practical Examples

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

#### {{ namespace }} Workflow

```bash
# 1. Run DCL first (create users and permissions)
docker compose run --rm migrate dcl -c /app/databases/mariadb/{{ namespace }}/dcl/config.js

# 2. Batch validate all DDL
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/{{ namespace }}

# 3. Run each database's DDL
docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/analytics/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/ecommerce/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/logging/config.js

# 4. Comprehensive testing (all databases)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  -o /app/reports

# 5. Verify DCL idempotency
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/{{ namespace }}/dcl/config.js

# 6. View test report
# Open reports/test-report-*.html in browser
```

#### CI/CD Integration

```bash
# Validate all migrations in CI pipeline
docker compose run --rm migrate validate -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# Run complete test
docker compose run --rm migrate test -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# Batch validate {{ namespace }}
docker compose run --rm migrate validate-all /app/databases/mariadb/{{ namespace }} || exit 1

# Test all databases in {{ namespace }} (Up-Down-Up)
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
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
    # Validate all {{ namespace }} DDL
    - docker compose run --rm migrate validate-all /app/databases/mariadb/{{ namespace }}
  
test-migrations:
  stage: test
  script:
    # Run comprehensive tests on {{ namespace }}
    - docker compose run --rm migrate test-all 
        --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js"
        -o /app/reports
  artifacts:
    paths:
      - reports/
    when: always

deploy-production:
  stage: deploy
  script:
    # Run DCL first
    - docker compose run --rm migrate dcl -c /app/databases/mariadb/{{ namespace }}/dcl/config.js
    # Run each database DDL
    - docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/analytics/config.js
    - docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/ecommerce/config.js
    - docker compose run --rm migrate up -c /app/databases/mariadb/{{ namespace }}/ddl/logging/config.js
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
│   └── adapters/
│       ├── index.js                # Adapter factory
│       ├── mongodb-adapter.js      # MongoDB adapter
│       └── mariadb-adapter.js      # MariaDB adapter
├── databases/
│   ├── mongodb/
│   │   ├── _templates/             # New project template (dcl/ + ddl/)
│   │   ├── test-success/           # MongoDB success cases
│   │   ├── test-failure/           # MongoDB failure cases (for validation)
│   │   ├── multi-instance/         # Multi-instance config (dcl/ + ddl/)
│   │   └── {{ namespace }}/        # Production server example
│   │       ├── dcl/                # DCL Repeatable migrations
│   │       └── ddl/                # DDL Versioned migrations
│   └── mariadb/
│       ├── _templates/             # New project template (dcl/ + ddl/)
│       ├── test-success/           # MariaDB success cases
│       ├── test-failure/           # MariaDB failure cases
│       ├── multi-instance/         # Multi-instance config (dcl/ + ddl/)
│       └── {{ namespace }}/        # Production server (3 DBs: ecommerce/analytics/logging)
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

```sql
-- 20250101000002-add-phone-column.sql

-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone'
-- END_CHECK

-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_name='users' AND index_name='idx_users_phone'
-- END_CHECK

-- +migrate Down
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone_verified;
ALTER TABLE users DROP COLUMN phone;
```

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
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  -o ./reports

# Console output only (no file saving)
node src/cli.js test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  --console-only
```

### Pattern Matching Examples

The `test-all` command supports glob patterns to selectively test databases:

```bash
# Test all DDL configs in {{ namespace }}
node src/cli.js test-all --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js"

# Test only analytics database
node src/cli.js test-all --pattern "databases/mariadb/{{ namespace }}/ddl/analytics/config.js"

# Test all MongoDB databases
node src/cli.js test-all --pattern "databases/mongodb/**/ddl/config.js"

# Test all DDL configs (exclude DCL)
node src/cli.js test-all --pattern "databases/**/ddl/**/config.js"

# Test specific projects
node src/cli.js test-all --pattern "databases/**/test-success/ddl/config.js"
```

**Pattern Syntax**:
- `**` - Matches any number of directories
- `*` - Matches any characters except `/`
- Paths are relative to workspace root

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

For complex scenarios like {{ namespace }} with multiple databases (ecommerce/analytics/logging), use auto-generation script:

#### Use gen-values.py to Auto-Generate values

```bash
# Preview generated values
python3 scripts/gen-values.py databases/mariadb/{{ namespace }} --dry-run

# Generate values.yaml file
python3 scripts/gen-values.py databases/mariadb/{{ namespace }} \
  --output values-{{ namespace }}.yaml \
  --namespace default \
  --mariadb-host mariadb-svc

# Deploy using generated values
helm install db-migrate ./charts/db-migrate -f values-{{ namespace }}.yaml
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
