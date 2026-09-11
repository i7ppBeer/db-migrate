# Multi-Instance Configuration

Manage multiple database instances from a single config file. All instances share the same migration files but each has its own connection settings.

---

## Configuration Format

### MongoDB Multi-Instance

```javascript
// test-fixtures/mongodb/multi-instance/ddl/config.js
export default {
  type: 'mongodb',
  migrationsDir: './migrations',  // Shared migration directory

  instances: [
    {
      name: 'mongo-primary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_primary'
      },
      changelogCollection: 'changelog'
    },
    {
      name: 'mongo-secondary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_secondary'
      },
      changelogCollection: 'changelog'
    }
  ]
};
```

### MariaDB Multi-Instance

```javascript
// test-fixtures/mariadb/multi-instance/ddl/config.js
export default {
  type: 'mariadb',
  migrationsDir: './migrations',  // Shared migration directory

  instances: [
    {
      name: 'mariadb-primary',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_primary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    },
    {
      name: 'mariadb-secondary',
      mariadb: {
        host: 'localhost',
        port: 3307,
        database: 'app_secondary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    }
  ]
};
```

---

## Commands

### DDL Multi-Instance

```bash
# Check all instances status
docker compose run --rm migrate status-all -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Run migrations on all instances
docker compose run --rm migrate up-all -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Dry Run
docker compose run --rm migrate up-all --dry-run -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
# (up-all has no --parallel flag — that's test-instances, below)

# Test all instances (Up-Down-Up)
docker compose run --rm migrate test-instances -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Validate only (skip Up-Down-Up)
docker compose run --rm migrate test-instances --validate-only -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# Parallel execution
docker compose run --rm migrate test-instances --parallel -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

### DCL Multi-Instance

```bash
# Run DCL on all instances
docker compose run --rm migrate dcl-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js

# Check DCL status on all instances
docker compose run --rm migrate dcl:status-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js

# Verify DCL idempotency on all instances
docker compose run --rm migrate dcl:verify-all -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
```

---

## Examples in This Repository

The `test-fixtures/` directory contains live multi-instance examples:

- `test-fixtures/mariadb/multi-instance/` — MariaDB DDL + DCL multi-instance
- `test-fixtures/mongodb/multi-instance/` — MongoDB DDL + DCL multi-instance
