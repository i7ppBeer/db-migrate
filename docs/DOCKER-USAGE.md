# Docker Compose Usage Guide

> Execute all CLI commands via Docker Container without installing Node.js locally.

## Setup

```bash
# Start databases
docker compose up -d mongodb mariadb

# First-time use requires building migrate service
docker compose build migrate
```

**Command Format**:
```bash
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

> **📝 Note**: Examples use `test-success`, `test-failure`, `multi-instance`, or `production-server` directories under `test-fixtures/`.

---

## Basic Commands

### Check Status (`status`)
```bash
docker compose run --rm migrate status -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

### Run Migrations (`up`)
```bash
# Run all pending migrations
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Dry run preview
docker compose run --rm migrate up --dry-run -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Enable Sanity Check
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

### Rollback Migrations (`down`)
```bash
# Rollback last 1 migration
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Rollback last 3 migrations
docker compose run --rm migrate down -n 3 -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

### Create Migration Files (`create` / `create-dcl`)
```bash
# Create DDL migration
docker compose run --rm migrate create add-orders-table -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Create DCL migration
docker compose run --rm migrate create-dcl readonly_users -c /app/test-fixtures/mariadb/production-server/dcl/config.js

# Specify sequence number
docker compose run --rm migrate create-dcl app_service -n 004 -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

### Validate Migrations (`validate`)
```bash
# Strict validation
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Allow dangerous operations
docker compose run --rm migrate validate --allow-dangerous -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Allow specific operations
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

### Batch Validation (`validate-all`)
```bash
# Validate entire directory's DDL + DCL
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server

# Validate DDL only (no database connection required)
docker compose run --rm migrate validate-all --ddl-only /app/test-fixtures/mariadb/production-server

# Validate DCL only (database connection required)
docker compose run --rm migrate validate-all --dcl-only /app/test-fixtures/mariadb/production-server
```

### Baseline Existing Migrations (`baseline`)
```bash
# Baseline all (Dry Run)
docker compose run --rm migrate baseline --all --dry-run -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Actual baseline
docker compose run --rm migrate baseline --all -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Baseline to specific version
docker compose run --rm migrate baseline --up-to 20250101000003-create-products.sql -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

### Up-Down-Up Test (`test`)
```bash
docker compose run --rm migrate test -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

---

## DCL Commands

### Run DCL Migrations (`dcl`)
```bash
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/production-server/dcl/config.js

# Dry Run
docker compose run --rm migrate dcl --dry-run -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

### Check DCL Status (`dcl:status`)
```bash
docker compose run --rm migrate dcl:status -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

### Verify DCL Idempotency (`dcl:verify`)
```bash
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

---

## Multi-Instance Commands

### Check All Instances Status (`status-all`)
```bash
docker compose run --rm migrate status-all -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

### Run All Instances Migrations (`up-all`)
```bash
docker compose run --rm migrate up-all -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Dry Run
docker compose run --rm migrate up-all --dry-run -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Parallel execution
docker compose run --rm migrate up-all --parallel -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

### Test All Instances (`test-instances`)
```bash
docker compose run --rm migrate test-instances -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Validate only (skip Up-Down-Up)
docker compose run --rm migrate test-instances --validate-only -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Parallel execution
docker compose run --rm migrate test-instances --parallel -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

### Multi-Instance DCL (`dcl-all` / `dcl:status-all` / `dcl:verify-all`)
```bash
# Run DCL on all instances
docker compose run --rm migrate dcl-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js

# Check DCL status on all instances
docker compose run --rm migrate dcl:status-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js

# Verify DCL idempotency on all instances
docker compose run --rm migrate dcl:verify-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
```

---

## test-all Command

The `test-all` command automatically handles DCL and DDL migrations differently:
- **DCL configs**: Validates + runs 3 times to verify idempotency
- **DDL configs**: Validates + runs Up-Down-Up test to verify rollback

```bash
# Test all projects in workspace
docker compose run --rm migrate test-all -o /app/reports

# Test specific namespace
docker compose run --rm migrate test-all \
  --pattern "test-fixtures/mariadb/production-server/**/config.js" \
  -o /app/reports

# Test only DDL configs (exclude DCL)
docker compose run --rm migrate test-all \
  --pattern "test-fixtures/**/ddl/**/config.js" \
  -o /app/reports

# Test specific database type
docker compose run --rm migrate test-all \
  --pattern "test-fixtures/mongodb/**/config.js" \
  -o /app/reports

# Console output only (do not save report files)
docker compose run --rm migrate test-all \
  --pattern "test-fixtures/mariadb/production-server/ddl/**/config.js" \
  --console-only
```

---

## Production Server Workflow

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

> **Path Notes**: Container paths start with `/app/test-fixtures/`. The `migrationsDir: './migrations'` in `config.js` is a relative path and does not need to change.
