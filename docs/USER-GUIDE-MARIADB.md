# MariaDB/MySQL DDL/DCL Writing Guide

> **Verified against the source on 2026-10-02.** Every complete example below passes `validate` unless it says otherwise, and the stored-procedure and permission examples were run against a real MariaDB. The full rule list lives in [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md).
>
> `up`/`sync` validate pending files before running them and refuse on failure; a DDL file needs a `-- +migrate Up` section (`MISSING_UP_MARKER`); `R__` files in a DDL directory are ignored. Rules can be tuned per project — see [VALIDATION-RULES-REFERENCE.md](./VALIDATION-RULES-REFERENCE.md#project-policy-turning-rules-off-down-or-up-and-adding-your-own).

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
- **Filename format**: `R__<name>.sql` — by convention `R__NNN_description.sql`; files run in file-name order
- **Characteristics**: Re-runs whenever its checksum changes; must be idempotent
- **Lives in**: a separate project with `mode: 'repeatable'` in its config (see [§7.2](#72-local-environment-setup))
- **Example**: `R__001_create_app_user.sql`

---

## 2. Versioned vs Repeatable Syntax Comparison

### 📁 Versioned (DDL) - Runs Once

| Operation Type | Syntax Example | Notes |
|---------|---------|------|
| Create a table | `CREATE TABLE users (...)` | ✅ Standard usage |
| Alter a table | `ALTER TABLE users ADD COLUMN email VARCHAR(255)` | ✅ Standard usage |
| Create an index | `CREATE INDEX idx_email ON users(email)` | ✅ Standard usage |
| Drop a table | `DROP TABLE IF EXISTS temp_table` | ⚠️ Fine in Down when Up created it; in Up, dropping an existing table is `DROP_TABLE` (dangerous) |
| Stored procedure / function | `CREATE PROCEDURE … BEGIN … END;` | ✅ DDL only — see [§3.6](#36-stored-procedures-and-functions) |
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
| Create a user | `CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'` | ✅ The placeholder gets a generated password ([DCL-PASSWORD.md](DCL-PASSWORD.md)) |
| Grant | `GRANT SELECT ON db.* TO 'app'@'%'` | ✅ Naturally idempotent |
| Flush privileges | `FLUSH PRIVILEGES` | ✅ Naturally idempotent |
| Drop a user | `DROP USER IF EXISTS 'old_user'@'%'` | 🔴 `DROP_USER` — needs `-- @allow-forbidden: true` |
| Revoke | `REVOKE INSERT ON db.* FROM 'app'@'%'` | 🔴 `REVOKE` — needs `-- @allow-forbidden: true`; errors (1147) if that exact grant doesn't exist |
| Change a password | `ALTER USER 'app'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'` | 🔴 `ALTER_USER` — needs `-- @allow-forbidden: true` (see the rotate-password template) |
| Tables, views, indexes, procedures, triggers | `CREATE TABLE …`, `CREATE PROCEDURE …` | ⛔ Never allowed in DCL (`*_IN_DCL`, can't be overridden) — put them in the DDL project |

**File structure** (same as [`templates/mariadb/dcl/TEMPLATE-create-user-readonly.sql`](../templates/mariadb/dcl/TEMPLATE-create-user-readonly.sql)):
```sql
-- Read-only account for reporting

CREATE USER IF NOT EXISTS 'app_readonly'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
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
-- @allow: DROP_COLUMN
-- @approved-by: Alice (CAB-1042)
```

Annotations are read from the leading comment block only — see [§5](#5-how-to-allow-dangerous-commands).

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

**🔴 DOWN block** *(required when Up changes anything)*
> Marker: `-- +migrate Down` — an empty Down after a real Up fails validation (`MISSING_DOWN`), and `down` refuses a file without one

```sql
DROP INDEX idx_phone ON users;
ALTER TABLE users DROP COLUMN phone;
```

---

#### Complete Example Structure

```sql
-- @allow: ...              -- ANNOTATION block (optional)

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
| **Down** | `-- +migrate Down` | ✅ Required when Up changes anything | Defines the SQL run for the "rollback" |
| **PreCheck** | `-- +sanity PreCheck` | ❌ Optional | Checks state before running — only with `--sanity-check` |
| **PostCheck** | `-- +sanity PostCheck` | ❌ Optional | Validates the result after running — only with `--sanity-check`; a failure runs Down |

### 3.3 Execution Flow

What `up` / `sync` do step by step — the gates R0–R6, PreCheck / Up / PostCheck per migration, automatic rollback, and the state left wherever a run stops — is drawn and explained in **[EXECUTION-FLOW.md](EXECUTION-FLOW.md)**, one page for MariaDB and MongoDB.

`--dry-run` stops after the gates and reports what would run or be refused. Details: [RUNTIME-GATE-PLAN.md](RUNTIME-GATE-PLAN.md), [LOCK-GUARD.md](LOCK-GUARD.md).

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

### 3.6 Stored Procedures and Functions

Procedures, functions and triggers belong in the **DDL** project (DCL refuses them). Write them **without `DELIMITER`** and add `-- @skip-syntax-check: true`:

```sql
-- @skip-syntax-check: true
-- (the SQL parser used by validate can't read CREATE/DROP PROCEDURE; the
--  forbidden/dangerous rules still apply)

-- +migrate Up
CREATE PROCEDURE sp_get_user_order_stats(IN p_user_id BIGINT)
BEGIN
    SELECT u.username,
           COUNT(o.id) AS order_count,
           COALESCE(SUM(o.total_amount), 0) AS total_spent
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.id = p_user_id
    GROUP BY u.id, u.username;
END;

CREATE FUNCTION fn_calculate_discount(p_amount DECIMAL(10,2), p_discount_rate DECIMAL(5,2))
RETURNS DECIMAL(10,2)
DETERMINISTIC
BEGIN
    RETURN p_amount * (1 - p_discount_rate / 100);
END;

-- +migrate Down
DROP FUNCTION IF EXISTS fn_calculate_discount;
DROP PROCEDURE IF EXISTS sp_get_user_order_stats;
```

- **No `DELIMITER`.** It's a command of the `mysql` command-line client, not SQL: the server rejects it, so a migration containing `DELIMITER //` fails when it runs (and, without `@skip-syntax-check`, already in `validate`). It isn't needed: the tool runs the section one statement at a time ([Lock Guard](LOCK-GUARD.md)) and keeps each `BEGIN … END;` body together as one statement, so a `;` inside the body doesn't split it. A section that can't be split with certainty, or any section with Lock Guard disabled, is sent as one batch, and the server reads the bodies correctly that way too.
- **`@skip-syntax-check: true` is needed** for files with `CREATE/DROP PROCEDURE`, `FUNCTION` or `TRIGGER` — otherwise `validate` reports `SQL_SYNTAX_ERROR`. It skips only that parser; every other check still runs.
- To change a procedure later, add a new migration that drops and recreates it (Down recreates the previous version).

### 3.7 DCL (Repeatable) Example

```sql
-- Application accounts. No +migrate markers: the whole file is run, and run
-- again whenever its content (checksum) changes, so every statement must be
-- safe to repeat.

CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON mydb.* TO 'app_user'@'%';

CREATE USER IF NOT EXISTS 'readonly_user'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON mydb.* TO 'readonly_user'@'%';

FLUSH PRIVILEGES;
```

- `CHANGE_ME_ON_FIRST_LOGIN` is replaced at runtime with a separately generated password per account; the passwords appear only in the run's notification email. An account that already exists keeps its password. Details: [DCL-PASSWORD.md](DCL-PASSWORD.md).
- Never put a real password in the file — it would end up in git.
- Preview a change with `dcl --plan` before running `dcl`.

### 3.8 Key Rules Summary

| Rule | Description |
|------|------|
| `-- +migrate Up` | **Required** in DDL files; marks the start of the forward migration block |
| `-- +migrate Down` | **Required** when Up changes anything (`MISSING_DOWN`) |
| `-- +sanity PreCheck` … `-- -sanity PreCheck` | **Optional** pre-check, run only with `--sanity-check`. The closing line is optional (the block also ends at the next `-- +migrate` / `-- +sanity`) |
| `-- +sanity PostCheck` … `-- -sanity PostCheck` | **Optional** post-check, same rules; a failure runs Down |
| `EXPECT_ROWS:` | Expects the query to **return** rows, otherwise the check fails |
| `EXPECT_NO_ROWS:` | Expects the query to return **no** rows, otherwise the check fails |
| Plain SQL in a sanity block | Treated as `EXPECT_ROWS` (statements separated by `;`) |
| `DELIMITER` | **Don't use it** — see [§3.6](#36-stored-procedures-and-functions) |
| DCL files | **Do not need** `+migrate Up/Down` — the entire file is what gets executed |

---

## 4. Dangerous Command List

Every rule, with its code, level and examples, is in **[VALIDATION-RULES-MARIADB.md](VALIDATION-RULES-MARIADB.md)** — that list is kept in sync with the code; this section is only the overview.

| Level | Blocks the run? | Typical codes | Released by |
|---|---|---|---|
| 🔴 Forbidden | Yes | `DROP_DATABASE`, `DROP_SCHEMA`; in DDL: `CREATE_USER`, `GRANT`, `REVOKE`, … (account changes belong in DCL); `INTO_OUTFILE`, `LOAD_DATA`, `SHUTDOWN`, `SET_GLOBAL`, `KILL`, replication commands | `@allow-forbidden: true`, `@allow: CODE`, `--allow-forbidden`, `--allow CODE` — record who approved it with `@approved-by` |
| 🔴 Forbidden in DCL | Yes | `DROP_USER`, `ALTER_USER`, `SET_PASSWORD`, `REVOKE` | same |
| ⛔ Never in DCL | Yes, no override | `CREATE_TABLE_IN_DCL`, `CREATE_ROUTINE_IN_DCL`, … (any schema object) | — move it to the DDL project |
| 🟠 Dangerous | Yes | `TRUNCATE_TABLE`, `DELETE_ALL` / `UPDATE_ALL` (no `WHERE`), `DROP_TABLE` (existing table), `DROP_COLUMN`, `DROP_INDEX`, `MODIFY_COLUMN`, `CHANGE_COLUMN`, `RENAME_TABLE`, `ALTER_TABLE_REBUILD`, `LOCK_TABLE`, `INSERT_SELECT` (no `WHERE`) | `@allow-dangerous: true`, `@allow: CODE`, `--allow-dangerous`, `--allow CODE` |
| 🟡 Warning | No | `ADD COLUMN` on large tables, `NOT NULL` without `DEFAULT`, `ENGINE=MyISAM`, `utf8`/`latin1`, `FLOAT`/`DOUBLE`, `ON DELETE CASCADE`, … | — |

Dangerous rules look only at the Up section — Down is expected to undo things.

---

## 5. How to Allow Dangerous Commands

### Option 1: Add an Annotation to the File (Recommended)

```sql
-- @allow: TRUNCATE_TABLE
-- @approved-by: Alice (ticket #123) — staging table, rebuilt nightly

-- +migrate Up
TRUNCATE TABLE temp_logs;

-- +migrate Down
SELECT 1;  -- nothing to restore
```

Prefer `@allow: CODE` (exactly what was reviewed) over `@allow-dangerous: true` (everything dangerous in the file). For a file that is already applied — and so must not be edited — put the allowance in the config instead: `validation: { allow: { '<file name>': ['CODE'] } }`.

### Option 2: CLI Flags

```bash
# Allow specific codes for this run (DDL: validate, up, sync, up-all)
docker compose run --rm migrate up --allow TRUNCATE_TABLE,DROP_INDEX -c <config>

# Allow all forbidden operations, recording who approved them
docker compose run --rm migrate up --allow-forbidden --approved-by "Alice (CAB-1042)" -c <config>

# DCL: validation runs only with --validate
docker compose run --rm migrate dcl --validate --allow-dangerous -c <config>
```

### Annotation Reference

| Annotation | Value | Description |
|------------|---|------|
| `@allow` | `CODE1,CODE2,...` | Allow specific operation codes (preferred) |
| `@allow-dangerous` | `true` / `false` | Allow every dangerous operation in the file |
| `@allow-forbidden` | `true` / `false` | Allow every forbidden operation in the file |
| `@approved-by` | name / ticket | Who approved the forbidden operations; required when `validation.requireApprover: true` |
| `@skip-syntax-check` | `true` | Skip the SQL parser (stored procedures, syntax it doesn't know); all other checks still run |
| `@statement-timeout-sec` | seconds (`0` = no limit) | Stop and roll back any statement of this file running longer; overrides `ddlSafety.statementTimeoutSec` |
| `@large-table-ok` | `true` | No R4 large-table warning for this file (reviewed) |

`@description` and `@type` appeared in older examples; they're informational only and have no effect.

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

See the diagram in [§3.3](#33-execution-flow). Sanity checks run only with `--sanity-check`; without it, PreCheck/PostCheck sections are ignored. A failed PreCheck stops the run before that migration executes; a failed PostCheck runs the Down section (unless `--no-auto-rollback`) and stops the run. Timeout per check: `sanityCheck.timeoutMs` in the config (default 30000).

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
-- @allow: MODIFY_COLUMN,ALTER_TABLE_MODIFY
-- (changing a column type rewrites the table — reviewed)

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
-- @allow: DROP_COLUMN

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
# Option 1: the published image — pin a version tag or commit SHA, not latest
docker pull ghcr.io/i7ppbeer/db-migrate/db-migrate:<version-or-sha>

# Option 2: build locally
git clone https://github.com/i7ppBeer/db-migrate.git
cd db-migrate
docker compose build migrate
```

Tags and the release process: [BUILD-IMAGE-GUIDE.md](BUILD-IMAGE-GUIDE.md#image-tags-ghcr).

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

**`ddl/config.js`:**
```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'mariadb',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'your_database',
    user: process.env.MARIADB_USER,          // required — no built-in default
    password: process.env.MARIADB_PASSWORD   // required — no built-in default
  },
  migrationsDir: './migrations',             // relative to this file
  changelogTable: 'schema_migrations'        // the default
};
```

**`dcl/config.js`** — `mode: 'repeatable'` is what makes it a DCL project:
```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  mariadb: { /* same connection settings */ },
  migrationsDir: './migrations',             // or a list: ['./shared', './prod-tw']
  checksumTable: 'dcl_repeatable_migrations' // the default
};
```

Other options (`createDatabaseIfMissing`, `ddlSafety.lockGuard`, `runtimeGates`, `validation`, `notifications`) are in the [README's configuration section](../README.md#-configuration-examples).

**TLS (e.g. AWS RDS with `require_secure_transport=ON`)** — add `ssl` next to the connection settings (inside `mariadb: { … }`, or at the top level of a flat config):

```javascript
ssl: { caFile: '/app/config/global-bundle.pem' }   // CA bundle; the server certificate is verified against it
// ssl: true                                       // TLS, verified against Node's default CAs
// ssl: { ca, cert, key, rejectUnauthorized, … }   // passed to the mysql2 driver as-is
```

`caFile` / `certFile` / `keyFile` are read for you. Without `ssl`, the connection is unencrypted, and a server that requires secure transport refuses it ("Connections using insecure transport are prohibited"). For RDS, download AWS's `global-bundle.pem` and ship it with the config — [`k8s/dynamic/`](../k8s/dynamic/README.md) mounts any `*.pem` in the profile directory at `/app/config/`. The same setting is used by the Docker entrypoint's wait-for-database check.

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

# Roll back 1 migration (shows the plan and asks; add --yes in CI, --dry-run to preview)
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/your-project/ddl/config.js

# status → validate → up → schema diff → notification email
docker compose run --rm migrate sync -c /app/test-fixtures/mariadb/your-project/ddl/config.js

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

# Preview: script diffs, affected accounts and their current grants, passwords to be generated
docker compose run --rm migrate dcl --plan -c /app/test-fixtures/mariadb/your-project/dcl/config.js

# Dry run (just the list of scripts that would run)
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
-- Application database users

-- Read-only user (reporting)
CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON your_database.* TO 'app_readonly'@'%';

-- Read-write user (application)
CREATE USER IF NOT EXISTS 'app_readwrite'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT, INSERT, UPDATE, DELETE ON your_database.* TO 'app_readwrite'@'%';

FLUSH PRIVILEGES;
```

`GRANT` is additive and safe to repeat. To take a privilege away later, edit the file to add a `REVOKE` for exactly what was granted, with `-- @allow-forbidden: true` (and `-- @approved-by:`) — see Scenario 5.

### Scenario 4: Stored Procedures (DDL)

Procedures and functions are schema objects: they go in the **DDL** project, not DCL. See [§3.6](#36-stored-procedures-and-functions) for the rules (no `DELIMITER`, `@skip-syntax-check: true`).

**File**: `20250126000004-order-procedures.sql`

```sql
-- @skip-syntax-check: true

-- +migrate Up
CREATE FUNCTION fn_calculate_age(birthdate DATE)
RETURNS INT
DETERMINISTIC
BEGIN
    RETURN TIMESTAMPDIFF(YEAR, birthdate, CURDATE());
END;

CREATE PROCEDURE sp_get_user_order_stats(
    IN p_user_id INT,
    OUT p_order_count INT,
    OUT p_total_spent DECIMAL(10,2)
)
BEGIN
    SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
    INTO p_order_count, p_total_spent
    FROM orders
    WHERE user_id = p_user_id;
END;

-- +migrate Down
DROP PROCEDURE IF EXISTS sp_get_user_order_stats;
DROP FUNCTION IF EXISTS fn_calculate_age;
```

Recurring maintenance (archiving or purging old rows on a schedule) is not a migration: a migration runs once per database. Run such jobs from a scheduler (cron, a Kubernetes CronJob, a MariaDB `EVENT`), and use a DDL migration only for a one-off cleanup — with `@allow` for the dangerous codes it uses.

### Scenario 5: Remove a Privilege or an Account (DCL)

**File**: `R__005_offboarding.sql`

```sql
-- @allow-forbidden: true
-- @approved-by: Alice (CAB-2001)

-- An account that's no longer used
DROP USER IF EXISTS 'old_batch_user'@'%';

-- Take back write access that was granted at database level
REVOKE INSERT, UPDATE, DELETE ON your_database.* FROM 'app_reporting'@'%';

FLUSH PRIVILEGES;
```

- `DROP USER` and `REVOKE` are forbidden in DCL by default; `@allow-forbidden` releases them and `@approved-by` records who agreed (required if `validation.requireApprover` is on).
- A `REVOKE` must match a grant that exists, at the same level: revoking table-level `SELECT` from an account that only has database-level `SELECT` fails with *ERROR 1147: There is no such grant defined*. To exclude a table, grant per table instead of `db.*`.
- Deleting the `R__` file that created an account does **not** remove the account — `dcl` refuses until you restore the file or confirm with `--accept-removed-dcl`. Remove accounts explicitly, as above.

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

Each environment has its own server, so give each one its own DCL directory — plus a shared one for accounts every environment needs:

```javascript
// dcl/config.js
export default {
  type: 'mariadb',
  mode: 'repeatable',
  instances: [
    { name: 'staging',    migrationsDir: ['./shared', './staging'],    mariadb: { host: 'db-staging.internal', database: 'app', user: process.env.MARIADB_USER, password: process.env.MARIADB_PASSWORD } },
    { name: 'production', migrationsDir: ['./shared', './production'], mariadb: { host: 'db-prod.internal',    database: 'app', user: process.env.MARIADB_USER, password: process.env.MARIADB_PASSWORD } }
  ]
};
```

**File**: `production/R__010_bi_readonly.sql`

```sql
-- BI tools: read-only, from the office network, without the sensitive tables
CREATE USER IF NOT EXISTS 'bi_readonly'@'10.0.%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

-- Grant per table rather than app.* minus some tables: MariaDB can't REVOKE
-- one table out of a database-level grant (ERROR 1147)
GRANT SELECT ON app.orders      TO 'bi_readonly'@'10.0.%';
GRANT SELECT ON app.order_items TO 'bi_readonly'@'10.0.%';
GRANT SELECT ON app.products    TO 'bi_readonly'@'10.0.%';

FLUSH PRIVILEGES;
```

Table-level grants need the tables to exist — run the DDL project first; on a server where `app.orders` doesn't exist yet the `GRANT` fails (*ERROR 1146*). Database-level grants (`app.*`) don't have that requirement.

`dcl-all -c dcl/config.js` runs each instance against its own directories and writes one notification email per instance (with that instance's passwords). Details: [MULTI-INSTANCE.md](MULTI-INSTANCE.md#different-accounts-per-instance-dcl).

---

## 🔗 Related Documents

- [CLI Usage Guide](CLI-USAGE-GUIDE.md)
- [Docker Compose User Guide](DOCKER-COMPOSE-USER-GUIDE.md)
