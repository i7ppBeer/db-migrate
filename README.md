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
- **Validation Rules**: Auto-detect dangerous operations, empty down(), orphaned drops, DCL operations in DDL, SQL syntax check (MariaDB), and FK integrity checks (MariaDB DDL)
- **DCL Auto-Generated Passwords**: Each `CHANGE_ME_ON_FIRST_LOGIN` placeholder is replaced at runtime with its own cryptographically secure 16-character password — original files are never modified; credentials are saved to `/tmp/secret`
- **Sanity Check**: Built-in Pre-Check / Post-Check / Auto-Rollback mechanism
- **Lock Guard (MariaDB)**: Bounded lock-wait timeout + retry on DDL execution, so an `ALTER TABLE` stuck behind a long transaction fails fast instead of queuing indefinitely and blocking every later query on that table — see [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md)
- **Report Generation**: JSON and HTML formats

---

## 📦 Installation

```bash
git clone https://github.com/your-org/db-migrate.git
cd db-migrate
npm install
```

---

## 🚀 Quick Start

### 1. Start Test Databases

```bash
docker compose up -d mongodb mariadb
```

### 2. Run Example Migrations

```bash
# MongoDB example
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js status
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up

# MariaDB example
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up
```

### 3. Validate Migrations

```bash
node src/cli.js validate -c test-fixtures/mariadb/test-success/ddl/config.js
```

### 4. Create a New Migration

```bash
node src/cli.js create add-users-table -c test-fixtures/mariadb/test-success/ddl/config.js
```

### 5. Run Up-Down-Up Test

```bash
node src/cli.js test -c test-fixtures/mariadb/test-success/ddl/config.js
```

---

## 📖 Basic Usage

### Commands

| Command | Description |
|---------|-------------|
| `status` | Show migration status |
| `up` | Apply pending migrations |
| `down -n <N>` | Rollback last N migrations |
| `create <name>` | Create a new DDL migration file |
| `validate` | Validate migration files |
| `validate-all <dir>` | Validate entire directory |
| `test` | Run Up-Down-Up test |
| `test-all` | Run all migration tests with reports |
| `dcl` | Run DCL (repeatable) migrations |
| `dcl:verify` | Verify DCL idempotency |
| `dcl:status` | Show DCL migration status |
| `create-dcl <name>` | Create a new DCL migration file |
| `baseline` | Baseline existing migrations |
| `reset --yes` | Delete all changelog/checksum records (dry-run without `--yes`) — does **not** run `down()` or touch schema/data |

### Command Format

```bash
# Local
node src/cli.js <command> [options] -c <config-path>

# Docker
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

---

## 📄 Configuration Examples

### Config Defaults & Delta Pattern

`loadConfig()` automatically loads a built-in defaults file from `src/config-defaults/` based on `type` + `mode`, then deep-merges the user config on top. Your `config.js` only needs to export fields that differ from the defaults.

### MongoDB DDL Config

```javascript
// Only override what differs from defaults
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGO_DB || 'myapp' }
};
```

### MariaDB DDL Config

```javascript
// host/port/user/password come from env vars (MARIADB_HOST etc.) or defaults
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
```

Every MariaDB DDL project also gets a **Lock Guard** on by default (bounded lock-wait + retry around each migration's SQL, so a stuck `ALTER TABLE` fails fast instead of hanging and jamming other queries behind it). Override it per project if needed:

```javascript
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  ddlSafety: {
    lockGuard: {
      enabled: true,          // set false to restore the old unguarded behavior
      lockWaitTimeoutSec: 5,  // SESSION lock_wait_timeout while running migration SQL
      innodbLockWaitTimeoutSec: 5,
      maxRetries: 3,          // give up after this many lock-wait-timeout failures
      retryDelayMs: 2000
    }
  }
};
```

See [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md) for why this exists and what it does and doesn't protect against.

### MongoDB DCL Config

```javascript
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },
  checksumCollection: '_dcl_migrations'
};
```

### MariaDB DCL Config

```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',
  checksumTable: '_dcl_migrations'
};
```

---

## 📂 Project Structure

```
ddl-migrate/
├── src/                          # Core source code
│   ├── cli.js
│   ├── core/
│   ├── adapters/
│   └── config-defaults/
├── test-fixtures/                # Integration test fixtures (real DB)
│   ├── mariadb/
│   │   ├── test-success/
│   │   ├── test-failure/
│   │   ├── multi-instance/
│   │   ├── production-server/
│   │   ├── dcl-scenario-test/
│   │   └── fk-test/
│   └── mongodb/
│       ├── test-success/
│       ├── test-failure/
│       ├── multi-instance/
│       └── production-server/
├── test/                         # Unit tests
├── scripts/                      # CI/build scripts
│   ├── build-migration-image.sh
│   ├── ci-migration-test.sh
│   ├── full-migration-test.sh
│   ├── local-test.sh
│   ├── run-tests.sh
│   └── smoke-test.sh
├── docker/
├── docs/                         # Detailed documentation
└── [config files]
```

---

## 🛡️ Validation

The `validate` command checks each migration file for:

- **Forbidden operations**: `DROP DATABASE`, `CREATE USER`, `GRANT` etc. in DDL (should be in DCL)
- **Dangerous operations**: `TRUNCATE TABLE`, `DROP COLUMN`, `DROP INDEX`, `collection.drop()` etc.
- **SQL Syntax errors** (MariaDB): Pre-validated with `node-sql-parser` before rule checks
- **FK Integrity** (MariaDB DDL): Detects FKs pointing to dropped or never-created tables
- **Empty down()**: UP has operations but DOWN is empty
- **Orphaned drops**: DOWN drops tables/collections not created by UP

### Allowance Mechanisms

```bash
# Allow all dangerous operations (CLI flag)
node src/cli.js validate --allow-dangerous -c <config>

# Allow specific operation codes
node src/cli.js validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

Per-file annotation (recommended — keeps approval traceable in code review):

```sql
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

See [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) for the full rules reference.

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [DOCKER-USAGE.md](docs/DOCKER-USAGE.md) | Complete Docker Compose command reference |
| [DCL-PASSWORD.md](docs/DCL-PASSWORD.md) | DCL auto-generated password mechanism |
| [MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md) | Multi-instance configuration guide |
| [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | test-all, validate-all, CI/CD integration |
| [VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) | Full validation rules reference |
| [CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) | Detailed CLI usage guide |
| [EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) | Onboarding existing databases |
| [LOCK-GUARD.md](docs/LOCK-GUARD.md) | MariaDB lock-wait guard: config, error behavior, and its limits |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Run unit tests: `npm test`
4. Submit a pull request

---

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.
