# DCL Auto-Generated Passwords & the Run Notification Email

DCL migration files (`R__*.sql` / `R__*.js`) may contain the literal placeholder `CHANGE_ME_ON_FIRST_LOGIN`. When the runner encounters this placeholder it **automatically generates a secure password at runtime** — no manual editing required.

The generated password is never printed to the console and never written back to the migration file. It also isn't written to a bare file on disk anymore (there used to be a `/tmp/secret` — that's gone). The one exception is MongoDB, below: a `.js` migration has to be imported from a file. Instead, every account/permission event from the run — a new password, a rotated password, an unchanged account, a removed account, a permission change — is collected and rendered into one **run notification email** (`notification.html`). The password only appears inside that one HTML document, for the two event types where there's a password to show.

---

## How It Works

**Each occurrence gets its own unique password.** A file that creates two accounts produces two independently generated passwords.

**Only occurrences outside comments count.** A comment that mentions `CHANGE_ME_ON_FIRST_LOGIN` (every official template has one) is left as-is and gets no password — SQL `-- …`, `# …`, `/* … */` and JS `// …`, `/* … */` are skipped, string literals are not. Before this was fixed, a commented mention shifted the username→password pairing by one and the email handed out a password that didn't work.

| | Detail |
|---|---|
| File on disk | Always unchanged — still contains `CHANGE_ME_ON_FIRST_LOGIN` |
| Checksum | Computed from the original file (rotation does **not** trigger re-run) |
| Substitution | In-memory only, immediately before the SQL/JS is sent to the DB |
| Per-occurrence | Each `CHANGE_ME_ON_FIRST_LOGIN` → independently generated password |
| Password in console | **Not shown** — only a brief notice is printed |
| Password on disk | Only inside `notification.html` (see below). MongoDB only: the resolved `.js` is briefly written to a private temp directory (`mkdtemp`, mode `0700`, file `0600`) so it can be `import()`ed, and the directory is deleted as soon as the module has loaded |

Under the hood: `RepeatableRunner.recordCredentialEvents()` (`src/core/repeatable-runner.js`) pushes one event per username onto `runner.credentialEvents` — it does no file I/O at all. The `dcl`/`dcl-all` CLI commands merge that list with `DCLIdempotentChecker`'s before/after account & permission diff (`buildDCLNotificationEvents()` in `src/core/reporter.js`) — one row per account: an account created and then rotated in the same run shows only its **final** password (with a note that it was set more than once), and MariaDB accounts are shown as `user@host`, so `svc@'%'` and `svc@'localhost'` stay separate — and hand the combined list to `reporter.js`'s `buildNotificationEmail()` / `notificationEmailToHTML()` to render, then `saveNotificationEmail()` to write.

---

## Password Rules

- 16 characters by default
- Characters: a-z · A-Z · 0-9 · 1–2 special chars (`-` or `~`); at least 2 lowercase, 2 uppercase, 2 digits
- Special chars are safe across MySQL/MariaDB CLI, `mongosh`, MongoDB URI, Bash, and ProxySQL

All of it is configurable through environment variables:

| Variable | Default |
|---|---|
| `DDL_MIGRATE_PASSWORD_LENGTH` | `16` (values below 8 fall back to 16) |
| `DDL_MIGRATE_PASSWORD_LOWER` / `_UPPER` / `_DIGITS` | `a-z` / `A-Z` / `0-9` |
| `DDL_MIGRATE_PASSWORD_SPECIAL` | `-~` |

Setting a character-set variable to an empty string is an error, not "use the default".

---

## The Notification Email

`dcl`, `dcl-all`, and `sync` all write a notification email after a run that changed anything:

```bash
node src/cli.js dcl -c <config>              # writes reports/notification.html
node src/cli.js dcl -c <config> -o /app/out  # writes /app/out/notification.html
node src/cli.js dcl-all -c <config>          # writes reports/notification-<instance>.html per instance
                                             #   + reports/notification-summary.html (no passwords)
node src/cli.js sync -c <config>             # writes reports/notification.html (DDL section)
```

`-o, --output <dir>` defaults to `reports/` when not given — the file is **always** written when there's anything to report, so a generated or rotated password is never silently lost just because nobody remembered the flag. This is deliberately independent of `sync`'s separate `-o`-gated JSON+HTML report (`saveSyncReport`) — that one stays opt-in.

The file name is fixed (`notification.html`, not timestamped) because it's meant to be fetched from a known path right after the run — e.g. `kubectl exec <pod> -- cat /app/reports/notification.html` from an external orchestrator — not archived alongside other reports.

### Event types

| Event | Shown in email | Password shown? |
|---|---|---|
| `new` | New account created | ✅ plaintext |
| `password_changed` | Existing account's password rotated (`ALTER USER`) | ✅ plaintext |
| `no_change` | Account already existed, password untouched | — |
| `removed` | Account dropped (or all grants revoked) | — |
| `permissions_updated` | Grants changed on an existing account | — (before/after grant list instead) |

A `new`/`password_changed` row states what the database **actually** does with that password — nothing is claimed that isn't enforced:

| Case | Text in the email |
|---|---|
| MariaDB, statement has a bare `PASSWORD EXPIRE` | must be changed on first login (the DB enforces it: until `SET PASSWORD`, every statement fails with error 1820) |
| MariaDB, no `PASSWORD EXPIRE` (or `EXPIRE NEVER` / `DEFAULT` / `INTERVAL n DAY`) | the database does not force a change — rotate it per your policy |
| MongoDB | change before `<customData.expiresAt date>` — recorded on the user, **not** enforced by MongoDB |

Add `PASSWORD EXPIRE` for accounts a person logs into. Leave it off for application/service accounts: an app connecting with an expired password gets error 1820 on every query.

### Multiple instances (`dcl-all`)

Each instance gets its **own** file, `notification-<instance name>.html`, with its own passwords — the same account name on two instances gets two different passwords, and one instance's password doesn't work on the other. The header shows the instance name **and** `host:port · db <name>`, so instances that share a database name (e.g. one `app` database per region) can't be confused.

`notification-summary.html` is written once per run: per instance, its status, `host:port`, which accounts changed and which file holds the details — **no passwords**, so it can go to whoever runs the rollout while each instance's file goes only to that instance's owner. A failed instance doesn't stop the others; the summary marks it failed and the command exits non-zero.

Instance names must be unique — two instances with the same name would write the same file and overwrite each other's passwords, so `dcl-all` refuses to start. For different accounts per instance, give each instance its own `migrationsDir` — see [MULTI-INSTANCE.md](MULTI-INSTANCE.md).

For `sync`, a DDL section is added above the DCL section listing the migrations applied (by filename/timestamp — that timestamp **is** the schema version) and a before/after field-level diff, reusing the same diff `printSchemaDiff()` shows on the console.

### Format

One consistent, mail-client-safe HTML template regardless of what happened — sections and rows just show up or don't:

- Plain `<table>` layout with inline styles only — no external CSS, no webfonts, no JS. Renders the same in Gmail, Outlook (desktop and web), Apple Mail, Yahoo, etc.
- `bgcolor` attributes alongside every inline `background-color` for Outlook's Word rendering engine.
- `<meta name="color-scheme" content="light">` / `<meta name="supported-color-schemes" content="light">` so a client's dark mode doesn't invert the event colors.
- No db-migrate version number, no internal table names (`_migrations`, `_dcl_migrations`) — just the facts of what changed.
- Header shows `project | environment | dbType | host:port · db <name> | timestamp` (credentials in a MongoDB URL are never shown). `environment` comes from the `DB_MIGRATE_ENVIRONMENT` env var (unset by default — the header simply omits it, it does **not** default to "production" or anything else).

---

## Kubernetes

There's no volume-mounting or `kubectl cp` dance needed, and specifically **don't rely on `ttlSecondsAfterFinished`** to give you a window to fetch the file after the fact — once a Job's container process exits (`restartPolicy: Never`), `kubectl exec`/`kubectl cp` can no longer reach its filesystem, TTL or not. Fetch it while the container is still alive, right after the command that wrote it:

```bash
kubectl exec <pod> -n <namespace> -- cat /app/reports/notification.html
```

is exactly the workflow this format was designed around (see `k8s/job.yaml` for the Job itself). Whatever fetches that output is responsible for actually sending the email and for not persisting the plaintext password anywhere beyond that.

---

## Examples

### MariaDB — Multiple Accounts (`R__004_secret_users.sql`)

```sql
-- Each CHANGE_ME_ON_FIRST_LOGIN is replaced with a different password at runtime
CREATE USER IF NOT EXISTS 'app_readonly'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
CREATE USER IF NOT EXISTS 'app_readwrite'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite'@'%';
FLUSH PRIVILEGES;
```

Produces two `new` events in the notification email.

### MariaDB — Forced Password Rotation (`R__005_rotate_passwords.sql`)

```sql
-- ALTER USER does not emit Note 1973, so every run generates a fresh password
ALTER USER 'app_readonly'@'%'  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
ALTER USER 'app_readwrite'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
FLUSH PRIVILEGES;
```

Produces two `password_changed` events, always — an `ALTER USER` targets an account that already exists by definition, but that must not suppress the event the way it does for `CREATE USER`.

### MongoDB — Each User Gets Its Own Password (`R__003_secret_users.js`)

```javascript
// Each entry in the users array has its own CHANGE_ME_ON_FIRST_LOGIN.
// The runner replaces them independently before the module is executed.
const users = [
  { username: 'app_readonly',  password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
  { username: 'app_readwrite', password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
];

for (const u of users) {
  const exists = (await adminDb.command({ usersInfo: u.username })).users.length > 0;
  if (!exists) {
    await adminDb.command({ createUser: u.username, pwd: u.password, roles: u.roles });
    createdUsernames.push(u.username);
  } else {
    await adminDb.command({ updateUser: u.username, roles: u.roles });
  }
}
return { passwordSet: createdUsernames.length > 0, createdUsernames, allUsernames };
```

### MongoDB — customData Injection

When a MongoDB DCL migration returns `{ passwordSet: true }`, the runner automatically calls `updateUser` to inject `customData` on every newly-created account:

```json
{
  "expiresAt": "<now + DCL_PASSWORD_EXPIRY_DAYS days>",
  "passwordLastModified": "<now>",
  "description": "Auto-created user, requires password change before expiry."
}
```

Set `DCL_PASSWORD_EXPIRY_DAYS` (default `7`) to control the expiry window. This is unrelated to `DB_MIGRATE_ENVIRONMENT` above — one controls a MongoDB account's own expiry metadata, the other only labels the notification email's header.

---

## Security Best Practices

1. **Never commit `reports/`** — it's already in `.gitignore`; don't override that.
2. **Treat `notification.html` as a one-time secret in transit** — read it, deliver it to wherever it needs to go, then don't keep a long-lived copy around. Nothing in this tool archives it for you.
3. **Rotate credentials** regularly by adding an `ALTER USER` DCL migration — that always produces a `password_changed` event regardless of whether the account already existed.
4. **Idempotency** — the checksum is computed from the original file (with `CHANGE_ME_ON_FIRST_LOGIN` intact), so password rotation does **not** trigger a re-run automatically.
5. **Run `dcl:verify` / `dcl:verify-all` / `test-all` against a scratch database.** They really execute the files (twice) to check idempotency, without recording checksums or writing an email. Accounts they create get a throwaway random password that nobody sees — so a later `dcl` run reports them as "already existed, password unchanged". If you did verify against a real database, rotate those accounts afterwards. (Previously the placeholder wasn't resolved on MariaDB, and such accounts ended up with the literal password `CHANGE_ME_ON_FIRST_LOGIN`.)
