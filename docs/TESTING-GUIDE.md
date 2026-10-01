# Testing Guide

---

## Up-Down-Up Test

Verifies that migrations can be applied, rolled back, and re-applied correctly.

```bash
# Single config
node src/cli.js test -c test-fixtures/mariadb/test-success/ddl/config.js

# Docker
docker compose run --rm migrate test -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

---

## DCL Idempotency Verification

Runs DCL migrations multiple times and verifies the result is the same on each execution.

```bash
# Single config
node src/cli.js dcl:verify -c test-fixtures/mariadb/production-server/dcl/config.js

# Docker
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/production-server/dcl/config.js
```

---

## test-all Command

Automatically detects DCL vs DDL configs and applies appropriate testing:

- **DCL configs** (`/dcl/config.js`): Validates + runs 3 times to verify idempotency
- **DDL configs** (`/ddl/**/config.js`): Validates + runs Up-Down-Up test

### Local Usage

```bash
# Test all configs in workspace
node src/cli.js test-all -o ./reports

# Test specific namespace
node src/cli.js test-all \
  --pattern "test-fixtures/mariadb/production-server/**/config.js" \
  -o ./reports

# Test only DDL configs
node src/cli.js test-all \
  --pattern "test-fixtures/**/ddl/**/config.js" \
  -o ./reports

# Test only DCL config
node src/cli.js test-all \
  --pattern "test-fixtures/mariadb/production-server/dcl/config.js" \
  -o ./reports

# Console output only (no file saving)
node src/cli.js test-all \
  --pattern "test-fixtures/mariadb/production-server/ddl/**/config.js" \
  --console-only
```

### Docker Usage

```bash
docker compose run --rm migrate test-all -o /app/reports

docker compose run --rm migrate test-all \
  --pattern "test-fixtures/mariadb/production-server/**/config.js" \
  -o /app/reports
```

### Pattern Syntax

| Pattern | Meaning |
|---|---|
| `**` | Matches any number of directories (recursive) |
| `*` | Matches any characters except `/` (single level) |

```bash
# All configs in production-server (both DCL and DDL)
--pattern "test-fixtures/mariadb/production-server/**/config.js"

# All MongoDB databases
--pattern "test-fixtures/mongodb/**/ddl/config.js"

# All DDL configs across all databases
--pattern "test-fixtures/**/ddl/**/config.js"
```

### --base-dir Option

When config files are stored outside the workspace (e.g. a mounted external volume):

```bash
# Configs at: /mnt/configs/project/dcl/config.js
node src/cli.js test-all \
  --base-dir /mnt/configs \
  --pattern "project/**/config.js"
```

---

## validate-all Command

Validates entire directories of DDL + DCL migration files.

```bash
# Validate all (DDL + DCL)
node src/cli.js validate-all test-fixtures/mariadb/production-server

# Validate DDL only (no database connection required)
node src/cli.js validate-all --ddl-only test-fixtures/mariadb/production-server

# Validate DCL only (database connection required)
node src/cli.js validate-all --dcl-only test-fixtures/mariadb/production-server

# Docker
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server
```

---

## CI/CD Integration

### GitHub Actions

```yaml
- name: Validate migrations
  run: |
    docker compose up -d mongodb mariadb
    docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server

- name: Run migration tests
  run: |
    docker compose run --rm migrate test-all \
      --pattern "test-fixtures/mariadb/production-server/ddl/**/config.js" \
      -o /app/reports
```

### GitLab CI

```yaml
stages:
  - validate
  - test
  - deploy

validate-migrations:
  stage: validate
  script:
    - docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server

test-migrations:
  stage: test
  script:
    - docker compose run --rm migrate test-all
        --pattern "test-fixtures/mariadb/production-server/ddl/**/config.js"
        -o /app/reports
  artifacts:
    paths:
      - reports/
    when: always

deploy-production:
  stage: deploy
  script:
    - docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/production-server/dcl/config.js
    - docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/analytics/config.js
    - docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/ecommerce/config.js
    - docker compose run --rm migrate up -c /app/test-fixtures/mariadb/production-server/ddl/logging/config.js
  when: manual
  only:
    - main
```

---

## Reports

Test reports are generated in JSON and HTML formats:

```bash
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

## Test Fixture Directories

| Directory | Purpose |
|---|---|
| `test-fixtures/mariadb/test-success/` | MariaDB migrations that should pass |
| `test-fixtures/mariadb/test-failure/` | MariaDB migrations that should fail validation — each with its exact expected codes |
| `test-fixtures/mariadb/fk-test/ddl-bad/` | Foreign-key mistakes that should fail validation |
| `test-fixtures/mongodb/test-success/` | MongoDB migrations that should pass |
| `test-fixtures/mongodb/test-failure/` | MongoDB migrations that should fail validation — each with its exact expected codes |

### Expected failures are declared per file

A fixture migration that must be rejected says exactly how, as its first line:

```sql
-- @expect-error: TRUNCATE_TABLE
```
```javascript
// @expect-error: DROP_DATABASE
```

`test-all` checks every DDL file individually: an annotated file must fail validation
with **exactly** those codes (a missing or an extra code fails the check), and a file
without the annotation must be valid. Each file is its own line in the report. A
directory that contains annotated files is not Up-Down-Up tested — its migrations are
meant to be refused, and `up`/`sync` would refuse them too.

This replaced a directory-wide `expectFailure: true` flag that counted the whole
directory as passing if *any* file failed. That flag was hiding real gaps when it was
removed: a MongoDB `dropDatabase()` fixture that validation let through, a
`deleteMany({})` fixture whose `up()` the validator only half-read (an apostrophe in a
comment and a nested `{ … }` both cut it short), and four fixtures written as
CommonJS that failed only because they couldn't be loaded at all.

DCL fixtures use the existing per-file `@expect-fail` annotation for scripts that are
meant to be non-idempotent.

---

## What runs against real databases

| Check | Where | Database |
|---|---|---|
| Unit tests (`npm test`) | CI `test` job | none — mocked drivers |
| `validate-all` on the success fixtures | CI `test` job | MariaDB + MongoDB (DCL idempotency) |
| `test-all`: per-file validation, Up-Down-Up, DCL idempotency, for every fixture | CI `e2e` job | MariaDB + MongoDB (docker compose) |
| Lock Guard scenarios (`npm run test:integration`) | CI `e2e` job, with `INTEGRATION_REQUIRE_DB=1` so a missing database fails instead of skipping | MariaDB |

Run the integration suite locally with `docker compose up -d mariadb` and
`npm run test:integration`; without a database it skips (unless
`INTEGRATION_REQUIRE_DB=1`).

### Remaining gaps

1. **Sanity-check rollback against a real database** — the success path (Pre-Check →
   migrate → Post-Check) runs in `test-all`; a Post-Check that genuinely fails and
   triggers a real `down()` does not.
2. **Runtime gates R2–R4** (`docs/RUNTIME-GATE-PLAN.md`) — not implemented yet.
3. **Bracket-notation validation bypass** (`docs/VALIDATION-RULES-MONGODB.md`
   discussion item #2) — static checks can't see `db['drop' + 'Database']()`; worth a
   test pinning the current behavior so it stays a documented gap.
4. **No coverage threshold** — coverage is configured (`vitest.config.js`) but not
   enforced.
