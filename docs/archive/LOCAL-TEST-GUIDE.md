> 📦 **Archived 2026-10-01** — merged into [TESTING-GUIDE.md § Running tests locally](../TESTING-GUIDE.md#running-tests-locally). Kept for history; don't follow it as current guidance.

# Local Migration Testing Guide

This guide explains how to test migrations locally against a real database:
starting it, running the Up → Down → Up flow, and checking status. It uses the
repo's real `docker-compose.yml` — there's no separate image to build first;
`docker compose run` builds the `migrate` service's image automatically from
the repo's `Dockerfile` the first time it's needed, and rebuilds it if the
Dockerfile or `src/` changed since.

> Rewritten 2026-09-29 — the previous version of this document and
> `scripts/local-test.sh` both depended on a `docker-compose.local-test.yml`
> that never existed anywhere in this repo (flagged by an audit on
> 2026-09-11, left unfixed until now). This version matches what's actually
> in the repo. `scripts/build-migration-image.sh` has the same class of bug
> (`-f Dockerfile.migrations --target runner`, neither of which exist) — it's
> unrelated to this local-test flow and hasn't been fixed; don't use it.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Manual Steps in Detail](#manual-steps-in-detail)
3. [Using Different Databases](#using-different-databases)
4. [Common Command Reference](#common-command-reference)
5. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Method 1: One-click test script

```bash
# Run the full test (up -> down -> up) against MongoDB
./scripts/local-test.sh

# Test MariaDB instead
./scripts/local-test.sh -d mariadb

# Stop and remove containers/volumes when done
./scripts/local-test.sh --clean
```

This runs `status` → `up` → `down` → `up` → `status` against the
`test-fixtures/<db-type>/test-success/ddl/config.js` fixture, using the real
`docker-compose.yml`'s `mongodb`/`mariadb` services and its generic `migrate`
service (`--profile tools`).

### Method 2: Manual execution

```bash
# 1. Start MongoDB
docker compose up -d mongodb

# 2. Run up (docker compose builds the migrate image automatically first time)
docker compose --profile tools run --rm migrate up -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# 3. Run down
docker compose --profile tools run --rm migrate down -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# 4. Run up again
docker compose --profile tools run --rm migrate up -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# 5. Check status
docker compose --profile tools run --rm migrate status -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# 6. Clean up
docker compose down -v
```

---

## Manual Steps in Detail

### Step 1: Start the test database

```bash
# MongoDB
docker compose up -d mongodb

# Or MariaDB
docker compose up -d mariadb

# Confirm it's healthy
docker compose ps
```

### Step 2: Run migration commands

Every command needs `-c <config>` pointing at a real project — there's no
default config baked into the `migrate` service, unlike the old script's
per-database services. Use a `test-fixtures/` fixture for testing, or your
own project's config for real use:

```bash
# Check status (which migrations are pending)
docker compose --profile tools run --rm migrate status -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# Run all pending migrations
docker compose --profile tools run --rm migrate up -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# Roll back the last migration
docker compose --profile tools run --rm migrate down -c /app/test-fixtures/mongodb/test-success/ddl/config.js

# Validate migration files
docker compose --profile tools run --rm migrate validate -c /app/test-fixtures/mongodb/test-success/ddl/config.js
```

### Step 3: Clean up the test environment

```bash
# Stop the containers
docker compose down

# Stop and delete data (volumes)
docker compose down -v
```

---

## Using Different Databases

### MongoDB

```bash
docker compose up -d mongodb
docker compose --profile tools run --rm migrate up -c /app/test-fixtures/mongodb/test-success/ddl/config.js
```

Connection defaults (from `docker-compose.yml`'s `migrate` service): host
`mongodb`, port `27017`, no auth.

### MariaDB

```bash
docker compose up -d mariadb
docker compose --profile tools run --rm migrate up -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

Connection defaults: host `mariadb`, port `3306`, user `root`, password
`rootpass` (local-dev convenience only — never use `root` for a real
deployment, see `k8s/README.md`'s "Which DB user goes in the Secret").

There's no MongoDB-with-auth service in `docker-compose.yml` — add one there
first (see `mongodb`'s block for the pattern) if you need to test against an
authenticated MongoDB locally.

---

## Common Command Reference

### Migration commands

| Command | Description |
|---|---|
| `status` | Show migration status |
| `up` | Run all pending migrations |
| `down` | Roll back the last migration |
| `validate` | Validate migration files |
| `test` | Up → Down → Up round trip for one config |
| `sync` | status → up → diff → real schema (see [CLI-USAGE-GUIDE.md](../CLI-USAGE-GUIDE.md)) |

### Docker Compose commands

```bash
# Start a service
docker compose up -d mongodb

# Run a migration command
docker compose --profile tools run --rm migrate <command> -c <config>

# View logs
docker compose logs -f mongodb

# Stop services
docker compose down

# Stop and clear data
docker compose down -v
```

### Test script parameters

```bash
./scripts/local-test.sh [options]

Options:
  -d, --db        Database: mongodb, mariadb (default: mongodb)
  -c, --clean     Stop and remove containers/volumes after the test
  -h, --help      Show help
```

---

## Troubleshooting

### Connection timeout / database not healthy

If the database doesn't come up healthy in time:

1. Check the container actually started: `docker ps`
2. Check its logs: `docker compose logs mongodb` (or `mariadb`)
3. On Windows, confirm Docker Desktop's WSL2 backend is running

### Permission Denied running the script

```bash
chmod +x scripts/local-test.sh
```

### `docker compose run` fails with an image/build error

The `migrate` service builds from this repo's `Dockerfile` automatically —
if that fails, the error is about the actual build (missing `package.json`
dependency, Dockerfile syntax, network access for `npm ci`), not about a
missing pre-built image. `docker compose build migrate` reproduces just the
build step on its own to debug it in isolation.
