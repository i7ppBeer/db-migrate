# DCL Auto-Generated Passwords

DCL migration files (`R__*.sql` / `R__*.js`) may contain the literal placeholder `CHANGE_ME_ON_FIRST_LOGIN`. When the runner encounters this placeholder it **automatically generates a secure password at runtime** — no manual editing required.

---

## How It Works

**Each occurrence gets its own unique password.** A file that creates two accounts will produce two completely different passwords.

| | Detail |
|---|---|
| File on disk | Always unchanged — still contains `CHANGE_ME_ON_FIRST_LOGIN` |
| Checksum | Computed from the original file (rotation does **not** trigger re-run) |
| Substitution | In-memory only, immediately before the SQL/JS is sent to the DB |
| Per-occurrence | Each `CHANGE_ME_ON_FIRST_LOGIN` → independently generated password |
| Password in console | **Not shown** — only a brief notice is printed |
| Password on disk | Appended to `/tmp/secret` (format: `username=password`, one per line) |

---

## Password Rules

- 16 characters
- Characters: a-z · A-Z · 0-9 · 1–2 special chars (`-` or `~`)
- Special chars are safe across MySQL/MariaDB CLI, `mongosh`, MongoDB URI, Bash, and ProxySQL

---

## /tmp/secret File Format

Positionally paired, accounts in declaration order:

```
app_readonly=6U3uELfN6alX0~CJ
app_readwrite=9kP2mQrX7sZa1-NW
```

> `/tmp/secret` is append-only. Manage or rotate it according to your security policy.  
> Mount a secured volume to `/tmp` or copy `/tmp/secret` out before the container terminates.

---

## Scenarios

| Scenario | `/tmp/secret` | Console |
|---|---|---|
| New account(s) | Appended | `📝 Credentials saved` |
| Account(s) already exist | NOT written | `⚠️ Account already existed — Skipped` |
| `ALTER USER` (forced rotation) | Always appended | `📝 Credentials saved` |

**Console output examples:**

New accounts:
```
[DCL] Auto-generated password for: R__004_secret_users.sql
  📝 [DCL] Credentials saved to /tmp/secret: app_readonly, app_readwrite
```

Already-existing accounts:
```
[DCL] Auto-generated password for: R__004_secret_users.sql
  ⚠️  [DCL] Account already existed — password NOT changed. Skipped /tmp/secret: app_readonly, app_readwrite
```

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

### MariaDB — Forced Password Rotation (`R__005_rotate_passwords.sql`)

```sql
-- ALTER USER does not emit Note 1973, so every run writes a fresh password
ALTER USER 'app_readonly'@'%'  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
ALTER USER 'app_readwrite'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
FLUSH PRIVILEGES;
```

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

Set `DCL_PASSWORD_EXPIRY_DAYS` (default `7`) to control the expiry window.

---

## Security Best Practices

1. **Never commit `/tmp/secret`** — add it to `.gitignore` or use a secrets manager
2. **Rotate credentials** regularly by adding an `ALTER USER` DCL migration
3. **In containerized environments** — mount a secured volume to `/tmp` or copy `/tmp/secret` out before the container terminates
4. **Idempotency** — the checksum is computed from the original file (with `CHANGE_ME_ON_FIRST_LOGIN` intact), so password rotation does **not** trigger a re-run automatically
