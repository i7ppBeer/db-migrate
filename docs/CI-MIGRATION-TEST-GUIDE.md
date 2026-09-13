# CI Migration Test Usage Guide

This document explains how to use the `ci-migration-test.sh` script, its flow diagrams, and how to integrate it into CI.

---

## Table of Contents

1. [Flowcharts](#1-flowcharts)
2. [Quick Start](#2-quick-start)
3. [Detailed Description](#3-detailed-description)
4. [CI Integration](#4-ci-integration)
5. [Troubleshooting](#5-troubleshooting)

---

## 1. Flowcharts

### 1.1 Full Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CI Migration Test Pipeline                          │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │    Start     │
                              └──────┬───────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 1: Start database services  │
                    │  (MariaDB / MongoDB / Both)     │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 2: Wait for databases to be ready │
                    │    (Health Check, max 30s)      │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     Step 3: Migration Test Cycle                            │
│                                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│   │   Phase 1   │    │   Phase 2   │    │   Phase 3   │    │   Phase 4   │ │
│   │   DDL       │───▶│   DCL       │───▶│  Migration  │───▶│  Migration  │ │
│   │  Validate   │    │  Validate   │    │   UP (1st)  │    │    DOWN     │ │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │ ✅/❌            │ ✅/⚠️            │ ✅/❌            │ ✅/❌   │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 5   │ │
│          │                  │                  │           │  Migration  │ │
│          │                  │                  │           │  UP (2nd)   │ │
│          │                  │                  │           └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 6   │ │
│          │                  │                  │           │  DCL Apply  │ │
│          │                  │                  │           └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 7   │ │
│          │                  │                  │           │   Status    │ │
│          │                  │                  │           │   Check     │ │
│          │                  │                  │           └─────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 4: Test result report   │
                    │  ┌─────────────────────────┐    │
                    │  │ Total:  X tests         │    │
                    │  │ Passed: Y               │    │
                    │  │ Failed: Z               │    │
                    │  │ Time:   Ns              │    │
                    │  └─────────────────────────┘    │
                    └────────────────┬────────────────┘
                                     │
                         ┌───────────┴───────────┐
                         │                       │
                         ▼                       ▼
                   ┌───────────┐          ┌───────────┐
                   │ Failed>0  │          │ Failed=0  │
                   │ exit 1    │          │ exit 0    │
                   │ CI FAILED │          │ CI PASSED │
                   └───────────┘          └───────────┘
```

### 1.2 Phase Details

```
═══════════════════════════════════════════════════════════════════════════════
                            Validate → Up → Down → Up
═══════════════════════════════════════════════════════════════════════════════

Phase 1: DDL Validate          Phase 2: DCL Validate
┌─────────────────────┐        ┌─────────────────────┐
│ • Check SQL/JS syntax │        │ • Validate idempotency │
│ • Validate filename format │        │ • Check annotations    │
│ • Check checksum     │        │ • Confirm repeatable execution │
│ • Verify no orphaned DROP │        └─────────────────────┘
└─────────────────────┘                   │
         │                                │ (optional)
         │ must succeed                        ▼
         ▼
Phase 3: Migration UP (1st)    Phase 4: Migration DOWN
┌─────────────────────┐        ┌─────────────────────┐
│ • Run all DDL in order │        │ • Run down() in reverse │
│ • Create tables       │───────▶│ • Remove all changes │
│ • Record to changelog │        │ • Clear changelog    │
└─────────────────────┘        └─────────────────────┘
                                          │
                                          ▼
Phase 5: Migration UP (2nd)    Phase 6: DCL Apply
┌─────────────────────┐        ┌─────────────────────┐
│ • Re-run all DDL      │        │ • Run user/permission management │
│ • Confirm repeatable deployment │───────▶│ • Enable --validate   │
│ • Verify idempotency   │        │ • Confirm accounts created successfully │
└─────────────────────┘        └─────────────────────┘
                                          │
                                          ▼
                               Phase 7: Status Check
                               ┌─────────────────────┐
                               │ • Show final status       │
                               │ • Confirm all migrations │
                               │   ran successfully      │
                               └─────────────────────┘
```

### 1.3 Test Decision Tree

```
                                    Start test
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
              [MariaDB]                              [MongoDB]
                    │                                      │
           ┌───────┴───────┐                      ┌───────┴───────┐
           │               │                      │               │
           ▼               ▼                      ▼               ▼
     DDL Validate    DCL Validate           DDL Validate    DCL Validate
           │               │                      │               │
           │   ┌───────────┘                      │   ┌───────────┘
           ▼   ▼                                  ▼   ▼
      UP (1st)                                UP (1st)
           │                                      │
           ▼                                      ▼
        DOWN                                    DOWN
           │                                      │
           ▼                                      ▼
      UP (2nd)                                UP (2nd)
           │                                      │
           ▼                                      ▼
      DCL Apply                               DCL Apply
           │                                      │
           ▼                                      ▼
     Status Check                            Status Check
           │                                      │
           └──────────────┬───────────────────────┘
                          ▼
                    Generate report
                          │
                          ▼
              ┌───────────────────────┐
              │  Failed > 0 → exit 1  │
              │  Failed = 0 → exit 0  │
              └───────────────────────┘
```

---

## 2. Quick Start

### 2.1 Basic Usage

```bash
# Grant execute permission
chmod +x scripts/ci-migration-test.sh

# Test all databases (strict mode)
./scripts/ci-migration-test.sh

# Test only MariaDB
./scripts/ci-migration-test.sh mariadb

# Test only MongoDB
./scripts/ci-migration-test.sh mongodb

# Test a specific project
./scripts/ci-migration-test.sh mariadb my-project
./scripts/ci-migration-test.sh mongodb my-project

# Allow dangerous operations (ALTER TABLE, DROP, etc.)
./scripts/ci-migration-test.sh all test-success --allow-dangerous
./scripts/ci-migration-test.sh mariadb test-success --allow-dangerous
```

### 2.2 Running via Docker Compose

```bash
# Go to the project directory
cd /path/to/ddl-migrate

# Run the full test
docker compose run --rm migrate sh -c "cd /app && ./scripts/ci-migration-test.sh"
```

---

## 3. Detailed Description

### 3.1 Script Parameters

| Parameter | Position | Default | Description |
|------|------|--------|------|
| `db-type` | $1 | `all` | Database type: `mariadb`, `mongodb`, `all` |
| `project-name` | $2 | `test-success` | Test project name |
| `--allow-dangerous` | flag | `false` | Allow dangerous operations to pass validation |

### 3.2 Exit Code

| Exit Code | Meaning | CI Status |
|-----------|------|---------|
| `0` | All tests passed | ✅ PASSED |
| `1` | Some tests failed | ❌ FAILED |

### 3.3 Test Phase Description

| Phase | Name | Description | Failure Handling |
|-------|------|------|----------|
| 1 | DDL Validate | Validate DDL script syntax and format | Stop testing |
| 2 | DCL Validate | Validate DCL script idempotency | Warn and continue |
| 3 | UP (1st) | Run migrations for the first time | Stop testing |
| 4 | DOWN | Roll back all migrations | Stop testing |
| 5 | UP (2nd) | Run migrations again | Record failure |
| 6 | DCL Apply | Run DCL to create accounts | Warn and continue |
| 7 | Status | Check final status | Record result |

### 3.4 Sample Output

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     CI Migration Test                                         ║
║     Validate → Up → Down → Up                                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Configuration:
  • Database type: all
  • Test project:   test-success
  • Run time:   2025-01-26 14:30:00

┌─────────────────────────────────────────────────────────────────┐
│ Step 1: Start database services
└─────────────────────────────────────────────────────────────────┘
   ▸ Starting MariaDB...
   ▸ Starting MongoDB...

┌─────────────────────────────────────────────────────────────────┐
│ Step 2: Wait for databases to be ready
└─────────────────────────────────────────────────────────────────┘
   ✅ MariaDB ready (3s)
   ✅ MongoDB ready (2s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Testing: mariadb / test-success
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ▸ [Phase 1] DDL Validate...
   ✅ [mariadb] DDL Validate
   ▸ [Phase 2] DCL Validate...
   ✅ [mariadb] DCL Validate
   ▸ [Phase 3] Migration UP (1st)...
   ✅ [mariadb] Migration UP (1st)
   ▸ [Phase 4] Migration DOWN...
   ✅ [mariadb] Migration DOWN
   ▸ [Phase 5] Migration UP (2nd)...
   ✅ [mariadb] Migration UP (2nd)
   ▸ [Phase 6] DCL Apply...
   ✅ [mariadb] DCL Apply
   ▸ [Phase 7] Final Status Check...
   ✅ [mariadb] Final Status

╔═══════════════════════════════════════════════════════════════╗
║                      Test Results                             ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   Total:   14 tests                                           ║
║   Passed:  14                                                 ║
║   Failed:  0                                                  ║
║   Time:    25s                                                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

CI PASSED
```

---

## 4. CI Integration

### 4.1 Azure DevOps Pipeline

```yaml
# azure-pipelines.yml
trigger:
  - main
  - develop

pool:
  vmImage: 'ubuntu-latest'

stages:
  - stage: Test
    displayName: 'Database Migration Test'
    jobs:
      - job: MigrationTest
        displayName: 'Run Migration Tests'
        steps:
          - task: DockerCompose@0
            displayName: 'Start Databases'
            inputs:
              containerregistrytype: 'Container Registry'
              dockerComposeFile: 'docker-compose.yml'
              action: 'Run services'
              detached: true
              buildImages: true

          - script: |
              chmod +x scripts/ci-migration-test.sh
              ./scripts/ci-migration-test.sh all test-success
            displayName: 'Run CI Migration Test'

          - task: PublishTestResults@2
            condition: always()
            inputs:
              testResultsFormat: 'JUnit'
              testResultsFiles: '**/reports/*.xml'
```

### 4.2 GitHub Actions

```yaml
# .github/workflows/migration-test.yml
name: Migration Test

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Start databases
        run: docker compose up -d mariadb mongodb

      - name: Wait for databases
        run: |
          docker compose exec -T mariadb mariadb-admin ping -h localhost -u root -prootpass --wait=30
          docker compose exec -T mongodb mongosh --eval "db.adminCommand('ping')"

      - name: Run Migration Test
        run: |
          chmod +x scripts/ci-migration-test.sh
          ./scripts/ci-migration-test.sh all test-success

      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: reports/
```

### 4.3 GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - test

migration-test:
  stage: test
  image: docker:24.0.7
  services:
    - docker:24.0.7-dind
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: "/certs"
  before_script:
    - apk add --no-cache docker-compose
  script:
    - docker compose up -d mariadb mongodb
    - sleep 10
    - chmod +x scripts/ci-migration-test.sh
    - ./scripts/ci-migration-test.sh all test-success
  artifacts:
    when: always
    paths:
      - reports/
```

### 4.4 Jenkins Pipeline

```groovy
// Jenkinsfile
pipeline {
    agent any
    
    stages {
        stage('Start Databases') {
            steps {
                sh 'docker compose up -d mariadb mongodb'
                sh 'sleep 10'
            }
        }
        
        stage('Migration Test') {
            steps {
                sh 'chmod +x scripts/ci-migration-test.sh'
                sh './scripts/ci-migration-test.sh all test-success'
            }
        }
    }
    
    post {
        always {
            sh 'docker compose down -v'
            archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
        }
    }
}
```

---

## 5. Troubleshooting

### 5.1 Common Issues

#### Database startup timeout

```
❌ MariaDB startup timed out
```

**Solution:**
```bash
# Manually check container status
docker compose ps
docker compose logs mariadb

# Clear old data and restart
docker compose down -v
docker compose up -d mariadb
```

#### Validate failure

```
❌ [mariadb] DDL Validate
```

**Solution:**
```bash
# Run validate on its own to see the detailed error
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Common causes:
# 1. Incorrect filename format (should be YYYYMMDDHHMMSS-xxx.sql)
# 2. SQL syntax error
# 3. An orphaned DROP statement exists
```

#### DOWN failure

```
❌ [mariadb] Migration DOWN
```

**Solution:**
```bash
# Check whether the down() function is correct
docker compose run --rm migrate status -c /app/test-fixtures/mariadb/test-success/ddl/config.js

# Possible causes:
# 1. down() function is missing or incomplete
# 2. Foreign key constraints prevent deletion
# 3. Data dependencies cause the rollback to fail
```

### 5.2 Debugging Tips

```bash
# View detailed logs
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/test-success/ddl/config.js 2>&1 | tee migration.log

# Enter the container for debugging
docker compose run --rm --entrypoint sh migrate

# Connect to the database to inspect it
docker compose exec mariadb mariadb -u root -prootpass -e "SHOW TABLES;"
docker compose exec mongodb mongosh --eval "db.getCollectionNames()"

# Clear all state and test again
docker compose down -v
./scripts/ci-migration-test.sh
```

### 5.3 Performance Optimization

```bash
# Parallel testing (if MariaDB and MongoDB are independent)
./scripts/ci-migration-test.sh mariadb test-success &
./scripts/ci-migration-test.sh mongodb test-success &
wait

# Use local cache
docker compose build --build-arg BUILDKIT_INLINE_CACHE=1 migrate
```

---

## Appendix: Full Parameter List

```bash
./scripts/ci-migration-test.sh [db-type] [project-name] [--allow-dangerous]

# db-type options:
#   all      - Test both MariaDB and MongoDB (default)
#   mariadb  - Test MariaDB only
#   mongodb  - Test MongoDB only

# project-name options:
#   test-success  - Default test project
#   test-failure  - Test project expected to fail
#   my-project    - Custom project name

# --allow-dangerous:
#   Allow dangerous operations such as ALTER TABLE, DROP, TRUNCATE to pass validation

# Environment variables:
#   No additional environment variables needed; uses the defaults in docker-compose.yml
```
