# MariaDB/MySQL DDL/DCL Writing Guide

> ⚠️ **Not fully verified (audited 2026-09-11)**: This document was written in the same batch as `MIGRATION-MANAGEMENT-GUIDE.md`, which has already been confirmed outdated. Spot-checking keywords turned up no broken flags/code, but it has not been checked line-by-line against the source — this counts as "no obvious errors found," not "verified correct." For rule details, defer to [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md).

> This guide explains how to write DDL (Data Definition Language) and DCL (Data Control Language) migration files for MariaDB/MySQL.

---

## 📋 Table of Contents

1. [File Types](#1-file-types)
2. [Versioned vs Repeatable Syntax Comparison](#2-versioned-vs-repeatable-syntax-comparison)
3. [Migration File Structure in Detail](#3-file-structure-in-detail)
4. [Dangerous Command List](#4-dangerous-command-list)
5. [How to Allow Dangerous Commands](#5-how-to-allow-dangerous-commands)
6. [Sanity Check Mechanism](#6-sanity-check-mechanism)
7. [Docker Environment Setup and CLI Usage](#7-docker-environment-setup-and-cli-usage)
8. [Scenario Walkthroughs](#8-scenario-walkthroughs)

---

## 1. File Types

### DDL (Versioned Migration)
- **Purpose**: Schema changes (creating tables, altering columns, adding indexes)
- **Filename format**: `YYYYMMDDHHMMSS-description.sql`
- **Characteristics**: Each file runs exactly once, in version order
- **Example**: `20250101000001-create-users.sql`

### DCL (Repeatable Migration)
- **Purpose**: Permission management (users, roles, grants)
- **Filename format**: `R__NNN_description.sql`
- **Characteristics**: Re-runs whenever its checksum changes; must be idempotent
- **Example**: `R__001_create_app_user.sql`

---

## 2. Versioned vs Repeatable Syntax Comparison

### 📁 Versioned (DDL) - Runs Once

| Operation Type | Syntax Example | Notes |
|---------|---------|------|
| Create a table | `CREATE TABLE users (...)` | ✅ Standard usage |
| Alter a table | `ALTER TABLE users ADD COLUMN email VARCHAR(255)` | ✅ Standard usage |
| Create an index | `CREATE INDEX idx_email ON users(email)` | ✅ Standard usage |
| Drop a table | `DROP TABLE IF EXISTS temp_table` | ⚠️ Belongs in the DOWN block |
| Add a foreign key | `ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id)` | ✅ Standard usage |
| Modify a column | `ALTER TABLE users MODIFY COLUMN name VARCHAR(500)` | ⚠️ May affect existing data |

**File structure:**
```sql
-- +migrate Up
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- +migrate Down
DROP TABLE IF EXISTS users;
```

### 📁 Repeatable (DCL) - Re-Runnable

| Operation Type | Syntax Example | Notes |
|---------|---------|------|
| Create a user | `CREATE USER IF NOT EXISTS 'app'@'%'` | ✅ Must be idempotent |
| Drop a user | `DROP USER IF EXISTS 'old_user'@'%'` | ✅ Must be idempotent |
| Grant | `GRANT SELECT ON db.* TO 'app'@'%'` | ✅ Naturally idempotent |
| Revoke | `REVOKE ALL ON db.* FROM 'app'@'%'` | ✅ Naturally idempotent |
| Flush privileges | `FLUSH PRIVILEGES` | ✅ Naturally idempotent |
| Stored procedure | `DROP PROCEDURE IF EXISTS ... CREATE PROCEDURE ...` | ✅ Requires DELIMITER |
| Function | `DROP FUNCTION IF EXISTS ... CREATE FUNCTION ...` | ✅ Requires DELIMITER |

**File structure:**
```sql
-- @description: Application users management
-- @type: dcl
-- @allow-dangerous: true

CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'password';
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';
FLUSH PRIVILEGES;
```

---

## 3. File Structure in Detail

### 3.1 Full File Structure Diagram

#### MariaDB Migration File Structure

**📄 ANNOTATION block** *(optional)*
> Metadata settings at the top of the file

```sql
-- @description: Describes what this migration does
-- @allow-dangerous: true
```

---

**🔵 UP block** *(required)*
> Marker: `-- +migrate Up`

Contains the following sub-blocks:

| Block | Marker | Required? | Description |
|------|------|--------|------|
| 🟡 **PreCheck** | `-- +sanity PreCheck` ... `-- -sanity PreCheck` | Optional | Checks state before running |
| 🟢 **Main SQL** | No marker | Required | The actual DDL statements to run |
| 🟡 **PostCheck** | `-- +sanity PostCheck` ... `-- -sanity PostCheck` | Optional | Validates the result after running |

**PreCheck example:**
```sql
-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM ... WHERE ...
-- EXPECT_ROWS: SELECT 1 FROM ... WHERE ...
-- -sanity PreCheck
```

**Main SQL example:**
```sql
ALTER TABLE users ADD COLUMN phone VARCHAR(20);
CREATE INDEX idx_phone ON users(phone);
```

**PostCheck example:**
```sql
-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema...
-- -sanity PostCheck
```

---

**🔴 DOWN block** *(recommended)*
> Marker: `-- +migrate Down`

```sql
DROP INDEX idx_phone ON users;
ALTER TABLE users DROP COLUMN phone;
```

---

#### Complete Example Structure

```sql
-- @description: ...        -- ANNOTATION block
-- @allow-dangerous: true

-- +migrate Up              -- Start of UP block

-- +sanity PreCheck         -- Start of PreCheck
-- EXPECT_NO_ROWS: ...
-- -sanity PreCheck         -- End of PreCheck

ALTER TABLE ...             -- Main SQL

-- +sanity PostCheck        -- Start of PostCheck
-- EXPECT_ROWS: ...
-- -sanity PostCheck        -- End of PostCheck

-- +migrate Down            -- Start of DOWN block
DROP TABLE ...
```

### 3.2 Block Reference

| Block | Marker | Required? | Purpose |
|------|------|--------|------|
| **Up** | `-- +migrate Up` | ✅ Required | Defines the SQL run for the "forward migration" |
| **Down** | `-- +migrate Down` | ⚠️ Recommended | Defines the SQL run for the "rollback" |
| **PreCheck** | `-- +sanity PreCheck` | ❌ Optional | Checks state before running |
| **PostCheck** | `-- +sanity PostCheck` | ❌ Optional | Validates the result after running |

### 3.3 Execution Flow

![MariaDB execution flow](images/mariadb-execution-flow.drawio.svg)

> 💡 **Tip**: This diagram can be edited directly with VS Code's [Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) extension.

### 3.4 Basic Example (Up/Down Only)

```sql
-- +migrate Up
CREATE TABLE users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY uk_username (username),
    UNIQUE KEY uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +migrate Down
DROP TABLE IF EXISTS users;
```

### 3.5 Complete Example (With PreCheck/PostCheck)

```sql
-- @description: Add a phone column
-- @allow-dangerous: true

-- +migrate Up

-- +sanity PreCheck
-- Confirm the users table exists
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
-- Confirm the phone column does not already exist (avoid re-running)
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PreCheck

-- Main SQL: add the column
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL AFTER email;

-- Create an index
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- Confirm the phone column was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- Confirm the index was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_phone'
-- -sanity PostCheck

-- +migrate Down
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone;
```

### 3.6 Stored Procedure Example (Using DELIMITER)

```sql
-- @description: Create an order-statistics stored procedure
-- @type: procedure

-- +migrate Up

DELIMITER //

CREATE PROCEDURE sp_get_user_order_stats(IN p_user_id BIGINT)
BEGIN
    SELECT 
        u.username,
        COUNT(o.id) AS order_count,
        COALESCE(SUM(o.total_amount), 0) AS total_spent
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.id = p_user_id
    GROUP BY u.id, u.username;
END //

CREATE FUNCTION fn_calculate_discount(
    p_amount DECIMAL(10,2),
    p_discount_rate DECIMAL(5,2)
) RETURNS DECIMAL(10,2)
DETERMINISTIC
BEGIN
    RETURN p_amount * (1 - p_discount_rate / 100);
END //

DELIMITER ;

-- +migrate Down
DROP FUNCTION IF EXISTS fn_calculate_discount;
DROP PROCEDURE IF EXISTS sp_get_user_order_stats;
```

### 3.7 DCL (Repeatable) Example

```sql
-- @description: Create application users
-- @type: dcl
-- @allow-dangerous: true

-- Note: DCL files do not need +migrate Up/Down markers
-- because DCL is Repeatable and re-runs whenever the checksum changes

-- Create the application account
CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'secure_password';

-- Grant privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_user'@'%';
GRANT EXECUTE ON mydb.* TO 'app_user'@'%';

-- Create a read-only account
CREATE USER IF NOT EXISTS 'readonly_user'@'%' IDENTIFIED BY 'readonly_password';
GRANT SELECT ON mydb.* TO 'readonly_user'@'%';

-- Flush privileges
FLUSH PRIVILEGES;
```

### 3.8 Key Rules Summary

| Rule | Description |
|------|------|
| `-- +migrate Up` | **Required** in DDL files; marks the start of the forward migration block |
| `-- +migrate Down` | **Recommended**; marks the start of the rollback block |
| `-- +sanity PreCheck` / `-- -sanity PreCheck` | **Optional**, must appear in pairs, wraps the pre-check |
| `-- +sanity PostCheck` / `-- -sanity PostCheck` | **Optional**, must appear in pairs, wraps the post-check |
| `EXPECT_ROWS:` | Expects the query to **return** rows, otherwise the check fails |
| `EXPECT_NO_ROWS:` | Expects the query to return **no** rows, otherwise the check fails |
| `DELIMITER` | **Required** for stored procedures/functions |
| DCL files | **Do not need** `+migrate Up/Down` — the entire file is what gets executed |

---

## 4. Dangerous Command List

### 🔴 Strictly Forbidden (Forbidden) - Requires `--allow-forbidden`

| Code | Syntax | Risk |
|-----|------|---------|
| `DROP_DATABASE` | `DROP DATABASE xxx` | Deletes an entire database |
| `DROP_SCHEMA` | `DROP SCHEMA xxx` | Deletes an entire schema |
| `CREATE_USER` | `CREATE USER 'xxx'@'%'` | Should be managed in the DCL project |
| `DROP_USER` | `DROP USER 'xxx'@'%'` | Should be managed in the DCL project |
| `ALTER_USER` | `ALTER USER 'xxx'@'%'` | Should be managed in the DCL project |
| `SET_PASSWORD` | `SET PASSWORD FOR 'xxx'@'%'` | Should be managed in the DCL project |
| `GRANT` | `GRANT xxx ON xxx TO xxx` | Should be managed in the DCL project |
| `REVOKE` | `REVOKE xxx ON xxx FROM xxx` | Should be managed in the DCL project |
| `FLUSH_PRIVILEGES` | `FLUSH PRIVILEGES` | Should be managed in the DCL project |
| `INTO_OUTFILE` | `SELECT ... INTO OUTFILE` | Data exfiltration risk |
| `LOAD_DATA` | `LOAD DATA INFILE` | Data injection risk |
| `SHUTDOWN` | `SHUTDOWN` | Shuts down the database |
| `SET_GLOBAL` | `SET GLOBAL xxx` | Changes system settings |
| `RESET_MASTER` | `RESET MASTER` | Breaks replication configuration |

### 🟠 Dangerous Operations (Dangerous) - Requires `--allow-dangerous` or `@allow-dangerous`

| Code | Syntax | Risk | Recommendation |
|-----|------|---------|------|
| `TRUNCATE_TABLE` | `TRUNCATE TABLE xxx` | Wipes the entire table | Use DELETE + WHERE |
| `DELETE_ALL` | `DELETE FROM xxx` (no WHERE) | Deletes all rows in the table | Add a WHERE condition |
| `UPDATE_ALL` | `UPDATE xxx SET ...` (no WHERE) | Updates all rows in the table | Add a WHERE condition |
| `DROP_COLUMN` | `ALTER TABLE xxx DROP COLUMN` | Permanently deletes a column | Confirm it's unused first |
| `DROP_INDEX` | `DROP INDEX xxx` | Affects query performance | Confirm no queries rely on it first |
| `RENAME_TABLE` | `RENAME TABLE xxx` | Breaks the application | Confirm all references are updated |
| `MODIFY_COLUMN` | `MODIFY COLUMN xxx` | Data conversion may fail | Validate in a test environment first |
| `LOCK_TABLE` | `LOCK TABLE xxx` | Blocks all queries | Use a transaction or row locks |
| `ALTER_TABLE_MODIFY` | `ALTER TABLE MODIFY/CHANGE COLUMN` | Rebuilds the table and locks it for a long time | Validate in a test environment first |
| `ALTER_TABLE_REBUILD` | `ALTER TABLE CONVERT TO / ENGINE=` | Fully rebuilds the table | Use pt-osc for large tables |
| `INSERT_SELECT` | `INSERT ... SELECT` (no WHERE / no ON DUPLICATE KEY) | Locks the entire source table | Add a WHERE clause or batch it |

### 🟡 Advisory Warnings (Warnings) - Does Not Block, But Flags an Issue

| Syntax | Warning |
|------|---------|
| `ALTER TABLE ADD COLUMN` | May take a long time on large tables |
| `ADD NOT NULL` (no DEFAULT) | Should be paired with a DEFAULT value |
| `AUTO_INCREMENT=xxx` | Setting it manually can cause ID collisions |
| `ENGINE=MyISAM` | Does not support transactions; use InnoDB instead |
| `CHARSET=latin1/utf8` | Use utf8mb4 instead |
| `FLOAT/DOUBLE` | Precision issues; use DECIMAL for monetary values |
| `ON DELETE CASCADE` | Can trigger cascading deletes |

---

## 5. How to Allow Dangerous Commands

### Option 1: Add an Annotation to the File (Recommended)

```sql
-- @description: Data cleanup script
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: TRUNCATE_TABLE,DELETE_ALL

TRUNCATE TABLE temp_logs;
DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

### Option 2: CLI Flags

```bash
# Allow all dangerous operations
docker compose run --rm migrate dcl --validate --allow-dangerous -c <config>

# Allow all forbidden operations (requires team approval)
docker compose run --rm migrate dcl --validate --allow-forbidden -c <config>

# Allow specific operation codes
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

### Annotation Reference

| Annotation | Value | Description |
|------------|---|------|
| `@allow-dangerous` | `true` / `false` | Allow all dangerous operations |
| `@allow-forbidden` | `true` / `false` | Allow all forbidden operations |
| `@allow` | `CODE1,CODE2,...` | Allow specific operation codes |
| `@description` | text | Describes this migration |
| `@type` | `procedure` / `maintenance` / `dcl` | Type marker |

---

## 6. Sanity Check Mechanism

Sanity checks provide **Pre-Check** and **Post-Check** mechanisms to ensure the state before and after a migration is correct, and support **automatic rollback**.

### 6.1 Sanity Check Syntax

```sql
-- +migrate Up

-- +sanity PreCheck
-- Pre-check: confirm the preconditions
-- EXPECT_ROWS: <SQL>      -- Expect a result to be returned
-- EXPECT_NO_ROWS: <SQL>   -- Expect no result to be returned
-- -sanity PreCheck

-- Main migration SQL
ALTER TABLE users ADD COLUMN phone VARCHAR(20);

-- +sanity PostCheck
-- Post-check: confirm the result
-- EXPECT_ROWS: <SQL>      -- Expect a result to be returned
-- EXPECT_NO_ROWS: <SQL>   -- Expect no result to be returned
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

### 6.2 Check Directive Reference

| Directive | Syntax | Description |
|------|------|------|
| `EXPECT_ROWS` | `-- EXPECT_ROWS: SELECT ...` | Expects the query to return results, otherwise it fails |
| `EXPECT_NO_ROWS` | `-- EXPECT_NO_ROWS: SELECT ...` | Expects the query to return no results, otherwise it fails |

### 6.3 Execution Flow

```
┌─────────────────┐
│   Pre-Check     │ ── Fail ──→ Stop, migration does not run
└────────┬────────┘
         │ Success
         ▼
┌─────────────────┐
│ Execute Migration│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Post-Check    │ ── Fail ──→ Automatic rollback (if enabled)
└────────┬────────┘
         │ Success
         ▼
      Done ✅
```

### 6.4 CLI Usage

```bash
# Run a migration with sanity checks enabled
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Disable automatic rollback (don't roll back when Post-Check fails)
docker compose run --rm migrate up --sanity-check --no-auto-rollback -c /app/test-fixtures/mariadb/your-project/ddl/config.js
```

### 6.5 Sanity Check Scenario Examples

#### Example 1: Confirm a Column Doesn't Exist Before Adding It

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm the phone column does not exist
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PreCheck

ALTER TABLE users ADD COLUMN phone VARCHAR(20) AFTER email;

-- +sanity PostCheck
-- Confirm the phone column was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

#### Example 2: Confirm the Table Exists Before Creating an Index

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm the products table exists
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
-- Confirm the index does not exist
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_products_category'
-- -sanity PreCheck

CREATE INDEX idx_products_category ON products(category_id, created_at DESC);

-- +sanity PostCheck
-- Confirm the index was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND INDEX_NAME = 'idx_products_category'
-- -sanity PostCheck

-- +migrate Down
DROP INDEX idx_products_category ON products;
```

#### Example 3: Confirm Data Compatibility Before Changing a Column Type

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm all price values are positive (safe to convert to DECIMAL)
-- EXPECT_NO_ROWS: SELECT 1 FROM products WHERE price < 0 OR price IS NULL LIMIT 1
-- Confirm there are no overly large price values
-- EXPECT_NO_ROWS: SELECT 1 FROM products WHERE price > 99999999.99 LIMIT 1
-- -sanity PreCheck

ALTER TABLE products MODIFY COLUMN price DECIMAL(10, 2) NOT NULL;

-- +sanity PostCheck
-- Confirm the column type was changed
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'price' AND DATA_TYPE = 'decimal'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE products MODIFY COLUMN price FLOAT;
```

#### Example 4: Confirm a Column Is Unused Before Dropping It

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm the deprecated_field column exists
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deprecated_field'
-- Confirm the column is entirely NULL (meaning it's unused)
-- EXPECT_NO_ROWS: SELECT 1 FROM users WHERE deprecated_field IS NOT NULL LIMIT 1
-- -sanity PreCheck

ALTER TABLE users DROP COLUMN deprecated_field;

-- +sanity PostCheck
-- Confirm the column was dropped
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'deprecated_field'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users ADD COLUMN deprecated_field VARCHAR(255);
```

#### Example 5: Create a New Table and Confirm Its Structure

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm the table does not exist
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'
-- -sanity PreCheck

CREATE TABLE audit_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    action ENUM('INSERT', 'UPDATE', 'DELETE') NOT NULL,
    record_id INT NOT NULL,
    user_id INT,
    old_values JSON,
    new_values JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_table_action (table_name, action),
    INDEX idx_created_at (created_at),
    INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +sanity PostCheck
-- Confirm the table was created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'
-- Confirm all indexes were created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_table_action'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_created_at'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_user_id'
-- -sanity PostCheck

-- +migrate Down
DROP TABLE IF EXISTS audit_logs;
```

#### Example 6: Confirm Data Integrity for a Data Migration

```sql
-- +migrate Up

-- +sanity PreCheck
-- Confirm the source data exists
-- EXPECT_ROWS: SELECT 1 FROM old_users LIMIT 1
-- Confirm the target table has been created
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'new_users'
-- -sanity PreCheck

-- Migrate data
INSERT INTO new_users (id, name, email, created_at)
SELECT id, CONCAT(first_name, ' ', last_name), email, created_at
FROM old_users
WHERE migrated = 0;

-- Mark as migrated
UPDATE old_users SET migrated = 1 WHERE migrated = 0;

-- +sanity PostCheck
-- Confirm all rows were migrated
-- EXPECT_NO_ROWS: SELECT 1 FROM old_users WHERE migrated = 0 LIMIT 1
-- Confirm the target table has data
-- EXPECT_ROWS: SELECT 1 FROM new_users LIMIT 1
-- -sanity PostCheck

-- +migrate Down
DELETE FROM new_users WHERE id IN (SELECT id FROM old_users WHERE migrated = 1);
UPDATE old_users SET migrated = 0 WHERE migrated = 1;
```

---

## 7. Docker Environment Setup and CLI Usage

### 7.1 Getting the Docker Image

```bash
# Option 1: Pull from a registry (if published)
docker pull your-registry/ddl-migrate:latest

# Option 2: Build locally
git clone https://github.com/your-org/ddl-migrate.git
cd ddl-migrate
docker compose build migrate
```

### 7.2 Local Environment Setup

**Directory structure:**
```
your-project/
├── docker-compose.yml
└── test-fixtures/
    └── mariadb/
        └── your-project/
            ├── ddl/
            │   ├── config.js
            │   └── migrations/
            │       ├── 20250101000001-create-users.sql
            │       └── 20250101000002-create-orders.sql
            └── dcl/
                ├── config.js
                └── migrations/
                    ├── R__001_app_users.sql
                    └── R__002_readonly_users.sql
```

**config.js example:**
```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'mariadb',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'your_database',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'  // for DDL
  // checksumTable: '_dcl_migrations'  // for DCL
};
```

### 7.3 Full CLI Command Reference

```bash
# ═══════════════════════════════════════════════════════════
# DDL (Versioned) operations
# ═══════════════════════════════════════════════════════════

# Check status
docker compose run --rm migrate status -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Run migrations
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Run migrations (with sanity checks enabled)
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Dry run (preview)
docker compose run --rm migrate up --dry-run -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Roll back 1 migration
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Validate migration files
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# Create a new DDL migration file
docker compose run --rm migrate create "add-email-to-users" -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# ═══════════════════════════════════════════════════════════
# DCL (Repeatable) operations
# ═══════════════════════════════════════════════════════════

# Check DCL status
docker compose run --rm migrate dcl:status -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Run DCL (no validation)
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Run DCL (with validation enabled)
docker compose run --rm migrate dcl --validate -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Run DCL (allow dangerous operations)
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Dry run (preview)
docker compose run --rm migrate dcl --dry-run -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Create a new DCL migration file
docker compose run --rm migrate create-dcl "create-app-user" -n 001 -c /app/test-fixtures/mariadb/your-project/dcl/config.js
```

---

## 8. Scenario Walkthroughs

### Scenario 1: Create a New Table (DDL)

**File**: `20250126000001-create-products.sql`

```sql
-- +migrate Up
CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    stock INT NOT NULL DEFAULT 0,
    category_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_category (category_id),
    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +migrate Down
DROP TABLE IF EXISTS products;
```

### Scenario 2: Modify an Existing Table (DDL)

**File**: `20250126000002-add-product-description.sql`

```sql
-- +migrate Up
ALTER TABLE products 
    ADD COLUMN description TEXT AFTER name,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER stock;

CREATE INDEX idx_is_active ON products(is_active);

-- +migrate Down
DROP INDEX idx_is_active ON products;
ALTER TABLE products 
    DROP COLUMN description,
    DROP COLUMN is_active;
```

### Scenario 3: Create Application Users (DCL)

**File**: `R__001_app_users.sql`

```sql
-- @description: Application database users
-- @type: dcl

-- ========================================
-- Read-Only User (for reporting)
-- ========================================
CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'readonly_password_here';

-- Revoke all first (ensure clean state)
REVOKE ALL PRIVILEGES ON *.* FROM 'app_readonly'@'%';

-- Grant read-only access
GRANT SELECT ON your_database.* TO 'app_readonly'@'%';

-- ========================================
-- Read-Write User (for application)
-- ========================================
CREATE USER IF NOT EXISTS 'app_readwrite'@'%' IDENTIFIED BY 'readwrite_password_here';

REVOKE ALL PRIVILEGES ON *.* FROM 'app_readwrite'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE ON your_database.* TO 'app_readwrite'@'%';

-- ========================================
-- Apply changes
-- ========================================
FLUSH PRIVILEGES;
```

### Scenario 4: Create Stored Procedures (DCL)

**File**: `R__010_stored_procedures.sql`

```sql
-- @description: Application stored procedures
-- @type: procedure
-- @allow-dangerous: true

-- ========================================
-- Function: Calculate age from birthdate
-- ========================================
DELIMITER //

DROP FUNCTION IF EXISTS fn_calculate_age//

CREATE FUNCTION fn_calculate_age(birthdate DATE)
RETURNS INT
DETERMINISTIC
BEGIN
    RETURN TIMESTAMPDIFF(YEAR, birthdate, CURDATE());
END//

DELIMITER ;

-- ========================================
-- Procedure: Get user order statistics
-- ========================================
DELIMITER //

DROP PROCEDURE IF EXISTS sp_get_user_order_stats//

CREATE PROCEDURE sp_get_user_order_stats(
    IN p_user_id INT,
    OUT p_order_count INT,
    OUT p_total_spent DECIMAL(10,2)
)
BEGIN
    SELECT 
        COUNT(*),
        COALESCE(SUM(total_amount), 0)
    INTO 
        p_order_count,
        p_total_spent
    FROM orders
    WHERE user_id = p_user_id;
END//

DELIMITER ;

-- ========================================
-- Procedure: Archive old orders
-- ========================================
DELIMITER $$

DROP PROCEDURE IF EXISTS sp_archive_old_orders$$

CREATE PROCEDURE sp_archive_old_orders(IN p_days_old INT)
BEGIN
    DECLARE v_cutoff_date DATE;
    SET v_cutoff_date = DATE_SUB(CURDATE(), INTERVAL p_days_old DAY);
    
    -- Create archive table if not exists
    CREATE TABLE IF NOT EXISTS orders_archive LIKE orders;
    
    -- Move old orders to archive
    INSERT INTO orders_archive
    SELECT * FROM orders 
    WHERE order_date < v_cutoff_date
    AND id NOT IN (SELECT id FROM orders_archive);
    
    -- Delete archived orders
    DELETE FROM orders 
    WHERE order_date < v_cutoff_date
    AND id IN (SELECT id FROM orders_archive);
    
    SELECT ROW_COUNT() AS archived_count;
END$$

DELIMITER ;
```

### Scenario 5: Dangerous Operation - Data Cleanup (DCL)

**File**: `R__020_data_cleanup.sql`

```sql
-- @description: Periodic data cleanup job
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: DELETE_ALL,TRUNCATE_TABLE

-- ========================================
-- Clean up temporary tables
-- ========================================

-- Truncate temp processing table (safe - no important data)
TRUNCATE TABLE temp_processing_queue;

-- ========================================
-- Archive and clean old audit logs (90 days)
-- ========================================

-- First, ensure archive table exists
CREATE TABLE IF NOT EXISTS audit_logs_archive LIKE audit_logs;

-- Archive old logs
INSERT IGNORE INTO audit_logs_archive
SELECT * FROM audit_logs 
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- Delete archived logs from main table
DELETE FROM audit_logs 
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
AND id IN (SELECT id FROM audit_logs_archive);

-- ========================================
-- Clean up expired sessions
-- ========================================
DELETE FROM user_sessions 
WHERE expires_at < NOW();
```

### Scenario 6: Migration With Sanity Checks (DDL)

**File**: `20250126000003-add-phone-with-sanity.sql`

```sql
-- +migrate Up

-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PreCheck

ALTER TABLE users ADD COLUMN phone VARCHAR(20) AFTER email;

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

### Scenario 7: Multi-Environment Permission Management (DCL)

**File**: `R__003_environment_users.sql`

```sql
-- @description: Environment-specific users with dynamic passwords
-- @type: dcl

-- ========================================
-- Development Environment User
-- ========================================
CREATE USER IF NOT EXISTS 'dev_user'@'%' 
    IDENTIFIED BY 'dev_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'dev_user'@'%';
GRANT ALL PRIVILEGES ON dev_%.* TO 'dev_user'@'%';

-- ========================================
-- Staging Environment User  
-- ========================================
CREATE USER IF NOT EXISTS 'staging_user'@'%' 
    IDENTIFIED BY 'staging_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'staging_user'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON staging_%.* TO 'staging_user'@'%';

-- ========================================
-- Production Read-Only User (for BI tools)
-- ========================================
CREATE USER IF NOT EXISTS 'bi_readonly'@'10.0.%' 
    IDENTIFIED BY 'bi_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'bi_readonly'@'10.0.%';
GRANT SELECT ON production_db.* TO 'bi_readonly'@'10.0.%';

-- Disallow access to sensitive tables
REVOKE SELECT ON production_db.user_passwords FROM 'bi_readonly'@'10.0.%';
REVOKE SELECT ON production_db.payment_info FROM 'bi_readonly'@'10.0.%';

FLUSH PRIVILEGES;
```

---

## 📝 Best Practices

1. **DDL files must always have a Down block** to allow rollback
2. **DCL files must be idempotent** — use `IF EXISTS` / `IF NOT EXISTS`
3. **Add ALGORITHM=INPLACE for large-table operations** to avoid long table locks
4. **Never hardcode passwords** — use environment variables or a secret manager
5. **Dangerous operations need an explicit annotation** explaining why they're needed
6. **Test in a non-production environment first**, then run in production

---

## 🔗 Related Documents

- [CLI Usage Guide](CLI-USAGE-GUIDE.md)
- [Docker Compose User Guide](DOCKER-COMPOSE-USER-GUIDE.md)
- [Migration Management Guide](MIGRATION-MANAGEMENT-GUIDE.md)
