# MariaDB Lock Guard

Every MariaDB DDL migration now runs its SQL through a **Lock Guard**: a short, bounded lock-wait timeout with a limited number of retries, applied automatically before `up()` / `down()` execute a migration's SQL.

---

## Why This Exists

MariaDB's metadata lock (MDL) queue is **FIFO**. If a long-running, uncommitted transaction (e.g. a large batch `DELETE`) already holds a table open, an `ALTER TABLE` on that same table has to queue for an exclusive MDL. Because the queue is FIFO, any *new* query on that table that arrives after the `ALTER` is already queued — including a plain `SELECT` — gets stuck behind it too, even though a `SELECT` would otherwise be lock-compatible.

Without a bound, that queue can jam indefinitely: the `ALTER` waits for the long transaction, and everything else waits for the `ALTER`. Lock Guard exists so a stuck `ALTER`/`DROP`/`CREATE INDEX` etc. fails fast and loudly instead of silently parking in that queue and dragging every other query on the table down with it.

This is intentionally decoupled from table size — the failure mode above doesn't depend on how big the table is, only on whether something else is holding it open when the migration runs.

---

## What It Does

Before executing a migration's SQL, the adapter:

1. Runs `SET SESSION lock_wait_timeout = <n>` and `SET SESSION innodb_lock_wait_timeout = <n>` on its connection.
2. Executes the migration SQL.
3. If it fails with MariaDB's lock-wait-timeout error (`errno 1205` / `ER_LOCK_WAIT_TIMEOUT`), waits `retryDelayMs` and retries — up to `maxRetries` attempts total.
4. Any other error, or exhausting all retries, is re-thrown immediately (not retried) — `up()`/`down()` report it the same way they always have, and the migration stays pending (nothing is left half-applied).

This applies to every SQL execution path in `up()`, `upWithSanityCheck()`, and `down()`. It does **not** wrap the small changelog bookkeeping statements (`INSERT`/`DELETE` on the changelog table) — those are single-row and not the risk this guards against.

---

## Config

```javascript
// src/config-defaults/mariadb-ddl.js already sets this for every project;
// override only the fields you need to change.
export default {
  type: 'mariadb',
  database: 'myapp',
  ddlSafety: {
    lockGuard: {
      enabled: true,             // false restores the old unguarded behavior
      lockWaitTimeoutSec: 5,     // MDL wait bound
      innodbLockWaitTimeoutSec: 5, // row-lock wait bound
      maxRetries: 3,
      retryDelayMs: 2000
    }
  }
};
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to skip Lock Guard entirely and call `connection.query()` directly, as before this feature. |
| `lockWaitTimeoutSec` | `5` | How long a single attempt waits for the metadata lock before giving up. |
| `innodbLockWaitTimeoutSec` | `5` | How long a single attempt waits for an InnoDB row lock before giving up. |
| `maxRetries` | `3` | Total attempts before the error is reported and the migration stays pending. |
| `retryDelayMs` | `2000` | Delay between attempts. |

Worst-case wall time before failing loudly ≈ `maxRetries * lockWaitTimeoutSec + (maxRetries - 1) * retryDelayMs` seconds — with the defaults, about 19 seconds, instead of an unbounded wait.

---

## What It Does NOT Do

- **Doesn't make a big table's rebuild itself faster.** If an `ALTER TABLE` genuinely needs to copy a huge table (`MODIFY/CHANGE COLUMN`, `ENGINE=`, etc.), Lock Guard only bounds how long it waits *to start* — once it acquires the lock, a long rebuild still takes as long as it takes. That's a `pt-online-schema-change` / online-DDL problem, not a lock-wait problem.
- **Doesn't protect the other side.** A batch script running a large `DELETE`/`UPDATE` is a separate connection with its own session settings — Lock Guard only governs this tool's own connection. If you want the reverse case bounded too (a long-running DDL blocking a batch job), set `innodb_lock_wait_timeout` on that script's own connection.
- **Doesn't classify tables as "large" or "small."** There's deliberately no static table-size list to maintain (those go stale and can't be verified in lower environments with small test data). Lock Guard applies uniformly regardless of table size, because the failure mode it prevents doesn't depend on table size either.

---

## Testing

- Unit tests (mocked connection, fast, no real DB): `test/mariadb-adapter.test.js` → `describe('executeWithLockGuard', ...)`.
- End-to-end tests against a real MariaDB: `test/integration.test.js`, run via `npm run test:integration` (excluded from the default `npm test`). Requires `docker compose up -d mariadb` (or any reachable MariaDB via `MARIADB_HOST`/`MARIADB_PORT`); the suite skips itself cleanly if none is reachable.
