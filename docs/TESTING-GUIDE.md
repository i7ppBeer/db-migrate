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
| `test-fixtures/mariadb/test-failure/` | MariaDB migrations that should fail validation |
| `test-fixtures/mongodb/test-success/` | MongoDB migrations that should pass |
| `test-fixtures/mongodb/test-failure/` | MongoDB migrations that should fail validation |

---

## Known test gaps (audited 2026-09-10)

`npx vitest run` currently reports 504 `it()` blocks across 9 files — every single one
runs against a **mocked** driver (`vi.mock('mysql2/promise', ...)` /
`vi.mock('migrate-mongo', ...)`). There is exactly one file that talks to a real
database — `test/integration.test.js`, added on `feat/mariadb-lock-guard` — and even
that one has only been confirmed to *skip cleanly* when no database is reachable; its
actual lock-contention assertions have not yet been observed passing against a live
MariaDB (no Docker in the environment that wrote it — see that branch's PR notes).

Concretely, **nothing in this repo has ever executed a real up → down → up cycle, a
real sanity-check rollback, or a real DCL idempotency run against an actual database.**
The mocks return canned values (`[[]]`, `undefined`, etc.), so a test can pass while
asserting on a code path the mock made trivially succeed rather than on what MariaDB
or MongoDB actually does.

### Gap list, in priority order

1. **Real `up → down → up` cycle** (`runUpDownUpTest()` in `base-adapter.js`) — never
   run against a live DB. The `test` CLI command exercises this logic path but only
   against `test-success` fixtures with mocked connections in CI.
2. **Real sanity-check rollback** — `SanityChecker.runWithSanityCheck()`'s
   `postCheck` failure → `down()` → verify state path has unit tests for the state
   machine, but never against a database that could genuinely fail a post-check for a
   real reason (e.g. a column that didn't get the expected type).
3. **Real DCL idempotency** (`dcl:verify`) — `dcl-idempotent-checker.test.js` tests the
   *comparison logic* against synthetic before/after state objects, never against a
   database actually running the same DCL script three times.
4. **Lock Guard e2e scenarios** (the 3 scenarios in `test/integration.test.js`) —
   written, logic-reviewed, not yet observed passing.
5. **Runtime Gate plan** (`docs/RUNTIME-GATE-PLAN.md`, R0–R4) — not implemented, so
   nothing to test yet; listed here so it isn't forgotten once it is.
6. **Two confirmed FK/orphan-drop logic bugs** (`docs/VALIDATION-RULES-MARIADB.md`,
   "Confirmed logic bugs" section — traced by hand against the source, not inspection
   guesses): (a) `FK_REFERENCES_DROPPED_TABLE` is order-blind within one file and
   false-positives on a valid drop-then-recreate-then-reference sequence; (b)
   `ORPHAN_DROP_UP` never looks at `Down`, so a `Up: DROP TABLE x` / `Down: CREATE
   TABLE x` migration — a textbook-correct reverse migration — is unconditionally
   blocked with no bypass. Both are pure static-analysis bugs, closeable with unit
   tests alone, no database required. Highest-value items in this list precisely
   because they block *valid* migrations rather than just missing invalid ones.
7. **MongoDB `validateJSSyntax` multi-line `import` false-positive** — flagged in
   `docs/VALIDATION-RULES-MONGODB.md` discussion item #3, from code inspection only.
   Needs a `validateContent()` unit test with a multi-line import to confirm one way
   or the other — this one doesn't need a real database, it's a pure regex/parsing
   test and could be closed without any DB access.
8. **Bracket-notation validation bypass** (`docs/VALIDATION-RULES-MONGODB.md`
   discussion item #2) — worth a regression test asserting the *current* (bypassable)
   behavior, so it's a documented, deliberate gap rather than a silent one, even if
   nobody decides to close it right away. Also doesn't need a real database.

Items 1–5 need a reachable MariaDB and/or MongoDB (`docker compose up -d mariadb
mongodb`) that this environment doesn't have. Items 6–8 can be closed with unit tests
alone, no database required — good candidates to pick up first.
