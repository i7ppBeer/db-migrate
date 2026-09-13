# Local Migration Image Testing Guide

> ⚠️ **Known to be outdated (audited 2026-09-11)**: This document consistently references `docker-compose.local-test.yml`, which **does not exist in the repo** (`scripts/local-test.sh` also depends on this same nonexistent file, and is equally broken). The service names in this document (`mongodb-auth`, `migration-auth`, etc.) also don't match the real `docker-compose.yml` (the real services are `mongodb`/`mariadb`/`runner-mongodb`/`runner-mariadb`/`test-all`/`migrate`). To test locally right now, use the `docker-compose.yml` in the repo root instead (see [DOCKER-USAGE.md](./DOCKER-USAGE.md)). Whether to rewrite this document or create the missing compose file is still to be decided.

This guide explains how to test a Migration Image locally, including starting a mock DB and running the up/down/up flow.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Manual Steps in Detail](#manual-steps-in-detail)
3. [Using Different Databases](#using-different-databases)
4. [Pulling the Image from a Registry](#pulling-the-image-from-a-registry)
5. [Common Command Reference](#common-command-reference)

---

## Quick Start

### Method 1: One-click test script

```bash
# Run the full test (up -> down -> up)
./scripts/local-test.sh

# Specify an image version
./scripts/local-test.sh -i db-migrate:v1.2.3

# Test MariaDB
./scripts/local-test.sh -d mariadb

# Clean up after testing
./scripts/local-test.sh -c
```

### Method 2: Manual execution

```bash
# 1. Start a mock MongoDB
docker compose -f docker-compose.local-test.yml up -d mongodb

# 2. Wait for the DB to start (about 10 seconds)
sleep 10

# 3. Run up
docker compose -f docker-compose.local-test.yml run --rm migration up

# 4. Run down
docker compose -f docker-compose.local-test.yml run --rm migration down

# 5. Run up again
docker compose -f docker-compose.local-test.yml run --rm migration up

# 6. Check status
docker compose -f docker-compose.local-test.yml run --rm migration status

# 7. Clean up
docker compose -f docker-compose.local-test.yml down -v
```

---

## Manual Steps in Detail

### Step 1: Build the Migration Image

If you don't have an image yet, build one first:

```bash
# Build a local image
./scripts/build-migration-image.sh -t v1.0.0

# Or pull one from a registry
docker pull myregistry.azurecr.io/db-migrate:v1.0.0
docker tag myregistry.azurecr.io/db-migrate:v1.0.0 db-migrate:v1.0.0
```

### Step 2: Start the test database

```bash
# Start MongoDB (no auth)
docker compose -f docker-compose.local-test.yml up -d mongodb

# Or start MongoDB (with auth)
docker compose -f docker-compose.local-test.yml up -d mongodb-auth

# Or start MariaDB
docker compose -f docker-compose.local-test.yml up -d mariadb

# Wait for the database to be ready
sleep 10

# Confirm the database status
docker compose -f docker-compose.local-test.yml ps
```

### Step 3: Run migration commands

```bash
# Check status (which migrations are pending)
docker compose -f docker-compose.local-test.yml run --rm migration status

# Run all pending migrations
docker compose -f docker-compose.local-test.yml run --rm migration up

# Roll back the last migration
docker compose -f docker-compose.local-test.yml run --rm migration down

# Validate migration files
docker compose -f docker-compose.local-test.yml run --rm migration validate
```

### Step 4: Clean up the test environment

```bash
# Stop the containers
docker compose -f docker-compose.local-test.yml down

# Stop and delete data (volumes)
docker compose -f docker-compose.local-test.yml down -v
```

---

## Using Different Databases

### MongoDB (no auth)

```bash
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

Environment variables:
- `DB_HOST=mongodb`
- `DB_PORT=27017`
- `DB_NAME=test_db`

### MongoDB (with auth)

```bash
docker compose -f docker-compose.local-test.yml up -d mongodb-auth
docker compose -f docker-compose.local-test.yml run --rm migration-auth up
```

Environment variables:
- `DB_HOST=mongodb-auth`
- `DB_USER=admin`
- `DB_PASSWORD=testpassword`

### MariaDB

```bash
docker compose -f docker-compose.local-test.yml up -d mariadb
docker compose -f docker-compose.local-test.yml run --rm migration-mariadb up
```

Environment variables:
- `DB_HOST=mariadb`
- `DB_PORT=3306`
- `DB_USER=migrate`
- `DB_PASSWORD=migratepass`

---

## Pulling the Image from a Registry

### Azure Container Registry

```bash
# Log in to ACR
az acr login --name myregistry

# Pull the image
docker pull myregistry.azurecr.io/db-migrate:v1.2.3

# Set the environment variable
export MIGRATION_IMAGE=myregistry.azurecr.io/db-migrate:v1.2.3

# Run the test
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

### GitHub Container Registry

```bash
# Log in to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Pull the image
docker pull ghcr.io/myorg/db-migrate:v1.2.3

# Set the environment variable
export MIGRATION_IMAGE=ghcr.io/myorg/db-migrate:v1.2.3

# Run the test
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

### Using docker run directly

```bash
# Start MongoDB
docker run -d --name test-mongo -p 27017:27017 mongo:7

# Run the migration (replace with your image name)
docker run --rm \
  --network host \
  -e DB_TYPE=mongodb \
  -e DB_HOST=localhost \
  -e DB_PORT=27017 \
  -e DB_NAME=test_db \
  myregistry.azurecr.io/db-migrate:v1.2.3 \
  up

# Clean up
docker stop test-mongo && docker rm test-mongo
```

---

## Common Command Reference

### Migration commands

| Command | Description |
|------|------|
| `up` | Run all pending migrations |
| `down` | Roll back the last migration |
| `status` | Show migration status |
| `validate` | Validate migration files |
| `test` | Test a migration (up, then immediately down) |

### Docker Compose commands

```bash
# Start a service
docker compose -f docker-compose.local-test.yml up -d mongodb

# Run a migration
docker compose -f docker-compose.local-test.yml run --rm migration <command>

# View logs
docker compose -f docker-compose.local-test.yml logs -f mongodb

# Stop services
docker compose -f docker-compose.local-test.yml down

# Stop and clear data
docker compose -f docker-compose.local-test.yml down -v
```

### Test script parameters

```bash
./scripts/local-test.sh [options]

Options:
  -i, --image     Migration image (default: db-migrate:v1.0.0)
  -d, --db        Database: mongodb, mongodb-auth, mariadb
  -c, --clean     Clean up after testing
  -h, --help      Show help
```

---

## Complete Test Workflow Example

```bash
# 1. Build the image
./scripts/build-migration-image.sh -t v1.0.0

# 2. Start MongoDB
docker compose -f docker-compose.local-test.yml up -d mongodb
sleep 10

# 3. Check the initial status
docker compose -f docker-compose.local-test.yml run --rm migration status
# Expected: 5 pending migrations

# 4. Run UP
docker compose -f docker-compose.local-test.yml run --rm migration up
# Expected: all migrations run

# 5. Check status again
docker compose -f docker-compose.local-test.yml run --rm migration status
# Expected: 4-5 applied, 0-1 pending

# 6. Run DOWN (roll back 1)
docker compose -f docker-compose.local-test.yml run --rm migration down
# Expected: the last migration is rolled back

# 7. Run UP again
docker compose -f docker-compose.local-test.yml run --rm migration up
# Expected: the just-rolled-back migration runs again

# 8. Final status
docker compose -f docker-compose.local-test.yml run --rm migration status
# Expected: same as step 5

# 9. Clean up
docker compose -f docker-compose.local-test.yml down -v
```

---

## Troubleshooting

### Connection timeout

If you see `Database connection timeout`, check:

1. Whether the database container has started: `docker ps`
2. Whether the network is correct: `docker network ls`
3. Whether you've waited long enough for the DB to start

### Permission Denied

If the scripts won't execute:

```bash
chmod +x scripts/local-test.sh
chmod +x scripts/build-migration-image.sh
```

### Image not found

If the image doesn't exist:

```bash
# List local images
docker images | grep db-migrate

# If it's missing, build one
./scripts/build-migration-image.sh -t v1.0.0
```
