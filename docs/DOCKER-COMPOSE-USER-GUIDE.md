# Docker Compose User Guide

> This guide walks through using docker-compose to run all CLI operations, from the user's perspective.

---

## Table of Contents

1. [Environment Setup](#1-environment-setup)
2. [DCL (Data Control Language) - Account/Permission Management](#2-dcl-data-control-language---accountpermission-management)
   - [First-Time Account Setup](#21-first-time-account-setup)
   - [Modify Permissions or Add Accounts](#22-modify-permissions-or-add-accounts)
   - [Validate DCL Scripts](#23-validate-dcl-scripts)
3. [DDL (Data Definition Language) - Schema Change Management](#3-ddl-data-definition-language---schema-change-management)
   - [Create Your First DDL Migration](#31-create-your-first-ddl-migration)
   - [Writing Up + PostCheck + Down](#32-writing-up--postcheck--down)
   - [Validate DDL Scripts](#33-validate-ddl-scripts)
4. [Live Connection Test (DCL + DDL Up/Down/Up)](#4-live-connection-test-dcl--ddl-updownup)
5. [Complete Example Workflow](#5-complete-example-workflow)
6. [Command Quick Reference](#6-command-quick-reference)

---

## 1. Environment Setup

### Start Database Services

```bash
# Start MariaDB and MongoDB databases
docker compose up -d mariadb mongodb

# Confirm the services are up and healthy
docker compose ps
```

### Create a Migration Runner Service (docker-compose.user.yml)

Create the following file in the project root to make later steps easier:

```yaml
# docker-compose.user.yml - for user operations
version: "3.8"

services:
  # Migration CLI tool
  migrate:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    working_dir: /app
    volumes:
      # Mount your migration directory
      - ./databases:/app/databases:ro
      - ./reports:/app/reports
    environment:
      - MARIADB_HOST=mariadb
      - MARIADB_PORT=3306
      - MARIADB_USER=root
      - MARIADB_PASSWORD=rootpass
      - MONGODB_HOST=mongodb
      - MONGODB_PORT=27017
    networks:
      - migrate-network
    profiles:
      - tools

networks:
  migrate-network:
    external: true
    # Compose prefixes the network name with the project name (usually the
    # directory the main docker-compose.yml lives in, e.g. "db-migrate" here,
    # not "mongodb-migrate") — confirm the real name with:
    #   docker network ls | grep migrate-network
    name: db-migrate_migrate-network
```

---

## 2. DCL (Data Control Language) - Account/Permission Management

DCL uses **Repeatable** mode: files start with `R__` and re-run whenever their content (checksum) changes.

### 2.1 First-Time Account Setup

#### Step 1: Copy a Template or Create the DCL Directory Structure

```bash
# Option 1: Copy an existing example and modify it (there's no _templates directory, so use a real example as your starting point)
cp -r test-fixtures/mariadb/test-success/dcl test-fixtures/mariadb/my-project/dcl

# Option 2: Create the directory manually
mkdir -p test-fixtures/mariadb/my-project/dcl/migrations
```

#### Step 2: Create the Config File (Skip This if You Used a Template)

```bash
cat > test-fixtures/mariadb/my-project/dcl/config.js << 'EOF'
/**
 * DCL Configuration - Account/Permission Management
 */
export default {
  type: 'mariadb',
  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306'),
  user: process.env.MARIADB_USER || 'root',
  password: process.env.MARIADB_PASSWORD || 'rootpass',
  database: 'mysql',  // DCL operations run against the mysql system database
  
  migrationsDir: './migrations',
  checksumTable: 'dcl_repeatable_migrations',
  mode: 'repeatable',
  
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
EOF
```

#### Step 3: Create the Default (Baseline) Account Script

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__00_default_users.sql << 'EOF'
-- R__00_default_users.sql
-- DCL Repeatable Migration: Default Service Account (baseline)
-- ⚠️ Must be IDEMPOTENT (safe to re-run)

-- ============================================
-- Default Service Account
-- For basic service connections; the password must be changed on first login
-- ============================================

-- Drop and recreate to guarantee idempotency
DROP USER IF EXISTS 'app_default'@'%';
CREATE USER 'app_default'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- Force a password change on first login

-- Basic SELECT privilege (adjust as needed)
GRANT SELECT ON mydb.* TO 'app_default'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 4: Create the Read-Only Account Script

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__01_readonly_users.sql << 'EOF'
-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users
-- ⚠️ Must be IDEMPOTENT (safe to re-run)

-- ============================================
-- Read-Only User (for reporting and queries)
-- ============================================

DROP USER IF EXISTS 'app_readonly'@'%';
CREATE USER 'app_readonly'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- Force a password change on first login

-- Grant SELECT only
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';

-- Optionally grant read-only access to other databases
-- GRANT SELECT ON analytics.* TO 'app_readonly'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 5: Create the Read-Write Account Script

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__02_readwrite_users.sql << 'EOF'
-- R__02_readwrite_users.sql
-- DCL Repeatable Migration: Read-Write Users (Application Accounts)
-- ⚠️ Must be IDEMPOTENT (safe to re-run)

-- ============================================
-- Application User (CRUD operations)
-- ============================================

DROP USER IF EXISTS 'app_readwrite'@'%';
CREATE USER 'app_readwrite'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- Force a password change on first login

-- SELECT, INSERT, UPDATE, DELETE privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 6: Run the DCL Migration

```bash
# Run DCL with docker-compose
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# Or use a shorthand alias (set up first)
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

### 2.2 Modify Permissions or Add Accounts

DCL runs in **Repeatable** mode — just edit the corresponding SQL file and re-run.

#### Adding an Account

```bash
# Add a DDL admin account
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__03_ddl_admin.sql << 'EOF'
-- R__03_ddl_admin.sql
-- DCL Repeatable Migration: DDL Admin User
-- ⚠️ Must be IDEMPOTENT (safe to re-run)

-- ============================================
-- DDL Admin (Schema administrator)
-- ============================================

DROP USER IF EXISTS 'app_ddl_admin'@'%';
CREATE USER 'app_ddl_admin'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;

-- DDL privileges: CREATE, ALTER, DROP, INDEX, etc.
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_ddl_admin'@'%';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON mydb.* TO 'app_ddl_admin'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Modifying Permissions

```bash
# Edit the corresponding SQL file directly
# Example: grant the readonly account access to the analytics database

# Edit R__01_readonly_users.sql and add:
# GRANT SELECT ON analytics.* TO 'app_readonly'@'%';
```

#### Re-Running DCL

```bash
# DCL automatically detects checksum changes and only re-runs modified files
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

#### Checking DCL Status

```bash
# See which DCL scripts need updating
docker compose run --rm migrate \
  node src/cli.js dcl:status \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

### 2.3 Validate DCL Scripts

#### Validate Idempotency

```bash
# Verify that all DCL scripts are idempotent (safe to re-run)
docker compose run --rm migrate \
  node src/cli.js dcl:verify \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

**Expected output:**

```
[DCL VERIFY] Testing idempotency (mariadb)...
══════════════════════════════════════════════════

📄 R__00_default_users.sql
   ✅ IDEMPOTENT

📄 R__01_readonly_users.sql
   ✅ IDEMPOTENT

📄 R__02_readwrite_users.sql
   ✅ IDEMPOTENT

══════════════════════════════════════════════════

✅ All DCL scripts are idempotent!
```

#### Dry Run Preview

```bash
# Preview which DCL scripts would run
docker compose run --rm migrate \
  node src/cli.js dcl --dry-run \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

## 3. DDL (Data Definition Language) - Schema Change Management

DDL uses **Versioned** mode: files start with a timestamp (e.g. `20250101000001-`), run in order, and only run once.

### 3.1 Create Your First DDL Migration

#### Step 1: Copy a Template or Create the DDL Directory Structure

```bash
# Option 1: Copy an existing example and modify it (there's no _templates directory, so use a real example as your starting point)
cp -r test-fixtures/mariadb/test-success/ddl test-fixtures/mariadb/my-project/ddl

# Option 2: Create the directory manually
mkdir -p test-fixtures/mariadb/my-project/ddl/migrations
```

#### Step 2: Create the Config File (Skip This if You Used a Template)

```bash
cat > test-fixtures/mariadb/my-project/ddl/config.js << 'EOF'
/**
 * DDL Configuration - Schema Change Management
 */
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'mydb',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'rootpass'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations',
  
  // Enable sanity checks
  sanityCheck: {
    enabled: true,
    autoRollback: true,
    verbose: true
  }
};
EOF
```

#### Step 3: Create a Migration File With the CLI

```bash
# Create a new DDL migration
docker compose run --rm migrate \
  node src/cli.js create create-users \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**Output:**
```
✅ Created: 20260121123456-create-users.sql

Remember to:
1. Implement the UP section
2. Implement the DOWN section
3. Run validation: db-migrate validate -c <config>
```

---

### 3.2 Writing Up + PostCheck + Down

#### Complete Example: Creating a Users Table

```sql
-- 20260121123456-create-users.sql
-- Migration: Create users table

-- +sanity PreCheck
-- Verify the users table does not already exist
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- END_CHECK

-- +migrate Up
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(100),
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive', 'pending', 'suspended') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY idx_users_email (email),
    KEY idx_users_status (status),
    KEY idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- Verify the users table was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='email'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_email'
-- END_CHECK

-- +migrate Down
DROP TABLE IF EXISTS users;
```

#### Example: Adding a Column

```sql
-- 20260121130000-add-phone-column.sql
-- Migration: Add phone column to users table

-- +sanity PreCheck
-- Verify users exists and the phone column does not yet exist
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- END_CHECK

-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL COMMENT 'User phone number';
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- Verify the column and index were created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone_verified'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_phone'
-- END_CHECK

-- +migrate Down
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone_verified;
ALTER TABLE users DROP COLUMN phone;
```

### Sanity Check Syntax Reference

| Syntax | Description |
|------|------|
| `-- +sanity PreCheck` | Start of a PreCheck block |
| `-- +sanity PostCheck` | Start of a PostCheck block |
| `-- EXPECT_ROWS: <SQL>` | The query is expected to return results (at least 1 row) |
| `-- EXPECT_NO_ROWS: <SQL>` | The query is expected to return no results (0 rows) |
| `-- END_CHECK` | End of a check block |

---

### 3.3 Validate DDL Scripts

#### Basic Validation

```bash
# Validate all DDL migration files
docker compose run --rm migrate \
  node src/cli.js validate \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**Expected output:**
```
[VALIDATE] Checking migrations (mariadb)...

[OK] 20260121123456-create-users.sql
[OK] 20260121130000-add-phone-column.sql

──────────────────────────────────────────────────
Total: 2 file(s)
Valid: 2
Invalid: 0

✅ All migrations are valid!
```

#### Allowing Dangerous Operations (When Needed)

```bash
# Allow dangerous operations (e.g. DROP TABLE)
docker compose run --rm migrate \
  node src/cli.js validate --allow-dangerous \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# Allow specific operation codes
docker compose run --rm migrate \
  node src/cli.js validate --allow DROP_TABLE,TRUNCATE \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

#### Checking Migration Status

```bash
# See which migrations have run and which are pending
docker compose run --rm migrate \
  node src/cli.js status \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 4. Live Connection Test (DCL + DDL Up/Down/Up)

### 4.1 Start the Test Database

```bash
# Make sure the database is running
docker compose up -d mariadb

# Wait for the database to be ready
docker compose exec mariadb mariadb-admin ping -h localhost -u root -prootpass --wait=30
```

### 4.2 Create the Test Database

```bash
# Create the database used for testing
docker compose exec mariadb mariadb -u root -prootpass -e "CREATE DATABASE IF NOT EXISTS mydb;"
```

### 4.3 Run DCL (Create Accounts)

```bash
# Step 1: Run DCL to create all accounts
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js

echo "✅ DCL completed"
```

### 4.4 Run DDL Up

```bash
# Run all pending DDL migrations
docker compose run --rm migrate \
  node src/cli.js up \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Up completed"
```

### 4.5 Run DDL Down

```bash
# Roll back the last migration
docker compose run --rm migrate \
  node src/cli.js down -n 1 \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Down completed"
```

### 4.6 Run DDL Up Again

```bash
# Run Up again to confirm it's re-runnable
docker compose run --rm migrate \
  node src/cli.js up \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Up completed again"
```

### 4.7 Use the Built-In Up-Down-Up Test

```bash
# Run the Up-Down-Up test in one command
docker compose run --rm migrate \
  node src/cli.js test \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**Expected output:**
```
🧪 Running Up-Down-Up Test (mariadb)...

══════════════════════════════════════════════════

[UP] Running migrations...
   ✅ Applied: 20260121123456-create-users.sql
   ✅ Applied: 20260121130000-add-phone-column.sql

[DOWN] Rolling back all migrations...
   ⏪ Rolled back: 20260121130000-add-phone-column.sql
   ⏪ Rolled back: 20260121123456-create-users.sql

[UP] Running migrations again...
   ✅ Applied: 20260121123456-create-users.sql
   ✅ Applied: 20260121130000-add-phone-column.sql

══════════════════════════════════════════════════

✅ Up-Down-Up Test PASSED!
   Duration: 2.35s
```

---

## 5. Complete Example Workflow

### One-Shot End-to-End Script

```bash
#!/bin/bash
# full-migration-test.sh

set -e  # Stop on first error

PROJECT_PATH="test-fixtures/mariadb/my-project"
DCL_CONFIG="/app/${PROJECT_PATH}/dcl/config.js"
DDL_CONFIG="/app/${PROJECT_PATH}/ddl/config.js"

echo "=========================================="
echo "  Full Migration Test Workflow"
echo "=========================================="

# 1. Start the database
echo ""
echo "📦 Step 1: Starting the database..."
docker compose up -d mariadb
sleep 5

# 2. Create the test database
echo ""
echo "📦 Step 2: Creating the test database..."
docker compose exec mariadb mariadb -u root -prootpass -e "CREATE DATABASE IF NOT EXISTS mydb;"

# 3. Validate DCL scripts
echo ""
echo "📋 Step 3: Validating DCL scripts..."
docker compose run --rm migrate node src/cli.js dcl:verify -c $DCL_CONFIG

# 4. Run DCL
echo ""
echo "🔐 Step 4: Running DCL (creating accounts)..."
docker compose run --rm migrate node src/cli.js dcl -c $DCL_CONFIG

# 5. Validate DDL scripts
echo ""
echo "📋 Step 5: Validating DDL scripts..."
docker compose run --rm migrate node src/cli.js validate -c $DDL_CONFIG

# 6. Run the DDL Up-Down-Up test
echo ""
echo "🧪 Step 6: Running the DDL Up-Down-Up test..."
docker compose run --rm migrate node src/cli.js test -c $DDL_CONFIG

# 7. Show the final status
echo ""
echo "📊 Step 7: Showing the final status..."
docker compose run --rm migrate node src/cli.js status -c $DDL_CONFIG
docker compose run --rm migrate node src/cli.js dcl:status -c $DCL_CONFIG

echo ""
echo "=========================================="
echo "  ✅ All tests passed!"
echo "=========================================="
```

### Running the Script

```bash
chmod +x full-migration-test.sh
./full-migration-test.sh
```

---

## 6. Command Quick Reference

### DCL (Repeatable) Commands

| Operation | Command |
|------|------|
| Create a DCL file | `node src/cli.js create-dcl <name> -c <config>` |
| Run DCL | `node src/cli.js dcl -c <config>` |
| Check DCL status | `node src/cli.js dcl:status -c <config>` |
| Validate idempotency | `node src/cli.js dcl:verify -c <config>` |
| Preview (dry run) | `node src/cli.js dcl --dry-run -c <config>` |

### DDL (Versioned) Commands

| Operation | Command |
|------|------|
| Create a migration | `node src/cli.js create <name> -c <config>` |
| Run Up | `node src/cli.js up -c <config>` |
| Run Down | `node src/cli.js down -n <count> -c <config>` |
| Up with sanity checks | `node src/cli.js up --sanity-check -c <config>` |
| Check status | `node src/cli.js status -c <config>` |
| Validate migrations | `node src/cli.js validate -c <config>` |
| Reset tracking records (leaves actual data untouched; dry-run by default) | `node src/cli.js reset -c <config>` |
| Reset tracking records (actually deletes) | `node src/cli.js reset --yes -c <config>` |
| Up-Down-Up test | `node src/cli.js test -c <config>` |
| Preview (dry run) | `node src/cli.js up --dry-run -c <config>` |

### Docker Compose Shortcuts

```bash
# Define an alias for convenience
alias migrate='docker compose run --rm migrate node src/cli.js'

# Then use it like this:
migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## Appendix: Password Management Best Practices

### Using Environment Variables (Recommended for Production)

```sql
-- Do not hardcode passwords in SQL
-- Use a placeholder or environment variable instead

-- Example: preprocess with a shell
-- Substitute with envsubst before running

DROP USER IF EXISTS 'app_readonly'@'%';
CREATE USER 'app_readonly'@'%' 
  IDENTIFIED BY '${DB_READONLY_PASSWORD}'
  PASSWORD EXPIRE;
```

### Using a Secret Manager

```bash
# Fetch the password from a secret manager and set it as an environment variable
export DB_READONLY_PASSWORD=$(az keyvault secret show --name db-readonly-pass --vault-name myvault --query value -o tsv)

# Then run the migration
docker compose run --rm \
  -e DB_READONLY_PASSWORD="$DB_READONLY_PASSWORD" \
  migrate node src/cli.js dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

## Troubleshooting

### Q: DCL Fails With "not idempotent"

**A:** Make sure your DCL script uses the `DROP USER IF EXISTS` + `CREATE USER` pattern, not `CREATE USER` alone.

### Q: DDL Down Fails

**A:** 
1. Confirm the `-- +migrate Down` block has the correct rollback statements
2. Confirm the order is correct (drop the index before dropping the column)

### Q: PostCheck Fails

**A:** 
1. Check that the SQL syntax is correct
2. Confirm the `DATABASE()` function returns the expected database name
3. Confirm with `docker compose exec mariadb mariadb -u root -prootpass -e "SELECT DATABASE();"`

---

**Last updated:** 2026-01-21
