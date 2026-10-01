# Multi-Instance Configuration

Manage multiple database instances from a single config file. By default all instances share the same migration files and each has its own connection settings; an instance can also point at its own `migrationsDir` (see [Different accounts per instance](#different-accounts-per-instance-dcl)).

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

## Different accounts per instance (DCL)

Typical case: one server per region, every server has a database with the **same name** (`app`), but each region needs its own accounts. Give each instance its own `migrationsDir` — `dcl-all`, `dcl:status-all` and `dcl:verify-all` run each instance against its own directory (an instance without one uses the top-level `migrationsDir`):

```javascript
// dcl/config.js
const instance = (name, host, dir) => ({
  name,                       // must be unique — it names the notification file
  migrationsDir: dir,         // relative to this config file
  mariadb: { host, port: 3306, database: 'app', user: 'root', password: process.env.MARIADB_PASSWORD }
});

export default {
  type: 'mariadb',
  mode: 'repeatable',
  checksumTable: '_dcl_migrations',
  instances: [
    instance('prod-tw', 'db-tw.internal', './prod-tw'),   // R__001_tw_report.sql, …
    instance('prod-jp', 'db-jp.internal', './prod-jp'),   // R__001_jp_analyst.sql, …
  ]
};
```

Accounts every instance needs go into each directory (a copy of the same `R__` file per directory is fine — each instance tracks its own checksums in its own database).

`dcl-all -c dcl/config.js` then writes, under `reports/` (or `-o <dir>`):

| File | Contains | Send to |
|---|---|---|
| `notification-prod-tw-<runId>.html` | prod-tw's account changes **and its generated passwords**; header `prod-tw`, `db-tw.internal:3306 · db app` | prod-tw's owner only |
| `notification-prod-jp-<runId>.html` | same for prod-jp — different accounts, different passwords | prod-jp's owner only |
| `notification-summary-<runId>.html` | every instance's status, host, which accounts changed and which file has the details — **no passwords** | whoever runs the rollout |

All files of one run share `<runId>` (UTC time + random suffix), so no run overwrites another's passwords; the summary links to that run's files. Each name without the `-<runId>` part (`notification-prod-tw.html`, …) is a copy of the latest run's file, for fixed-path fetching. All are owner-only (`0600`) — delete them once delivered.

Because the database name alone is ambiguous here, every email and console line identifies an instance by name **and** `host:port`. Duplicate instance names are rejected before anything connects (they would overwrite each other's notification file). If one instance fails, the others still run and get their emails; the summary marks the failure and the command exits non-zero.

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
# Run DCL on all instances (writes notification-<instance>-<runId>.html per instance + notification-summary-<runId>.html)
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
