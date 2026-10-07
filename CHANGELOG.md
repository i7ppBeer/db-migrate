# Changelog

Every `vX.Y.Z` tag is a release. Each release has a section here written for the team
using the tool: what changed since the previous release, what's new, how to upgrade, and
what to watch out for. CI publishes the section as the GitHub Release and refuses to
release a tag that has no section (see [Releasing](#releasing) at the bottom).

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) — a release with breaking changes bumps the
major version.

## [Unreleased]

## [3.0.1] - 2026-10-06

Fixes since **3.0.0** — most of them about generated DCL passwords — plus MariaDB TLS
(needed for RDS) and a Kubernetes flow that runs DDL and DCL in one Job. No database
changes, no config changes required — but read **Behavior changes** if you script
`baseline` or read the pre-flight's `notification.html`.

### TL;DR

- **Rebuild / pull the image.** The DCL password fixes and TLS are in the image.
- **DCL: a generated password could be lost or wrong** when one R__ file mixed accounts
  that already existed with new ones. Fixed for MariaDB and MongoDB — every account is
  now judged on its own, and the emailed password is the one the account was created
  with.
- **MariaDB TLS**: new `ssl` option (`ssl: { caFile: '/path/global-bundle.pem' }`).
  Without it, servers with `require_secure_transport=ON` (common on RDS) refused the
  connection.
- **New: `k8s/dynamic/`** — one Job per deploy (timestamped name), DDL then DCL in one
  Pod, MariaDB or MongoDB, credentials from mounted Secret files, reports fetched by
  `collect.sh` for your own mail delivery. See [k8s/dynamic/README.md](k8s/dynamic/README.md).
- **`baseline --up-to` / `--file` no longer match a substring** from the middle of a
  file name.
- **Lock Guard retries only the statement that hit the lock timeout.** It used to
  re-run the whole migration, repeating statements that had already succeeded.

### Fixed

- **MariaDB Lock Guard re-ran the whole migration on a lock-wait retry.** MariaDB
  commits each DDL statement, so in a migration like `CREATE TABLE a …; ALTER TABLE b …`
  where the `ALTER` waited out the lock, the retry ran `CREATE TABLE a` again, failed
  with `Table 'a' already exists`, and left the migration half-applied behind an error
  that hid the real cause. Migrations now run one statement at a time and a retry
  repeats only the statement that timed out; an error in a multi-statement migration
  says which statement failed and that the ones before it were applied (they are not
  rolled back). Statements are split with an SQL-aware splitter (quotes, comments,
  `BEGIN … END` bodies of procedures / functions / triggers / events); SQL it can't split
  with certainty is sent as one batch with a single attempt. Reproduced and verified
  against MariaDB 11; `docs/LOCK-GUARD.md` corrected (it claimed nothing could be left
  half-applied).
- **MariaDB validation refused valid syntax** as `SQL_SYNTAX_ERROR`, because the SQL
  parser behind the syntax pre-check doesn't know it: every `ALTER TABLE … ADD [CONSTRAINT
  name] UNIQUE [INDEX|KEY]`, and the re-runnable forms `ADD INDEX / ADD UNIQUE / ADD
  PARTITION / CREATE INDEX IF NOT EXISTS`, `DROP COLUMN / DROP INDEX / MODIFY COLUMN IF
  EXISTS`. They're accepted now; the rest of each statement is still checked.
  `ADD CONSTRAINT … CHECK (…)` is still refused by the parser — use
  `-- @skip-syntax-check: true` for such a file.

- **DCL (MariaDB): a new account's password was lost when another account in the same
  file already existed.** The "does it exist" check was one yes/no for the whole file,
  so the new account was reported as `NO CHANGE` and its generated password was never
  shown. Each `'user'@'host'` is now looked up on its own.
- **DCL (MongoDB): a new account could be emailed another account's password.**
  Passwords were paired with `createdUsernames` (only the new accounts) by position,
  while they're generated per placeholder in file order. They're now paired with
  `allUsernames`; when the script's return value can't be lined up with the
  placeholders, the account is reported **without** a password ("couldn't be matched —
  rotate this account") instead of with a guess.
- **DCL (MariaDB): passwords shifted to the wrong account** when one `CREATE USER`
  created several accounts, or an account had no `@host`. The parser now maps each
  `CHANGE_ME_ON_FIRST_LOGIN` to exactly one account (no host = `'%'`); a placeholder
  whose account can't be recognized keeps its password in the email, labeled
  `(unrecognized account, statement N)`.
- **DCL (MariaDB): `CREATE OR REPLACE USER`, or `DROP USER` + `CREATE USER`, on an
  existing account was reported as `NO CHANGE`** although its password had been replaced
  — the new one was lost. It's now `PASSWORD CHANGED` with the new password. `ALTER USER`
  in a file that also creates accounts is `PASSWORD CHANGED` too (it was shown as `NEW`
  or `NO CHANGE`).
- **`dcl` printed "All DCL migrations are up-to-date."** after a failed run.
- **Image: `/tmp` was root-owned `755`**, so a non-root container (the k8s Jobs run as
  uid 1000) couldn't run MongoDB DCL scripts with generated passwords (`EACCES … mkdtemp`).
  Now `1777`.
- **`baseline --up-to` / `--file`** picked the first file whose name *contained* the
  argument (`users`, `2025`, …), so a short argument could mark the wrong range as
  applied. Now: the exact file name (with or without `.sql`/`.js`), or a prefix only one
  file has (e.g. its timestamp); a prefix several files share is an error listing them.

### New

- **Recovering from a failed migration**: `docs/DDL-PRODUCTION-SAFETY.md` §7.4 — what is
  and isn't all-or-nothing on MariaDB and MongoDB (measured on real servers), why not
  `down` (`down -n 1` after a failure rolls back the previous, successful migration), and
  how to write migrations that can simply be re-run, with PreCheck / PostCheck examples
  tested on MariaDB 11 and MongoDB 7.
- **R4 large-table warning (MariaDB)**: before `up` / `sync` / `up-all` (and their
  `--dry-run`), a pending migration that runs `ALTER TABLE`, `CREATE INDEX`,
  `OPTIMIZE TABLE`, `UPDATE` or `DELETE` on a table with `runtimeGates.largeTableRows`
  (1,000,000) rows or more is warned about, with the table's size — Lock Guard bounds
  only the wait for the lock, not how long the statement runs. Never blocks; `0` turns
  it off. The MariaDB counterpart of `largeCollectionDocs`. The warning names the
  statement time limit that applies; `-- @large-table-ok: true` silences it for a
  reviewed file.
- **Statement time limit (MariaDB)**: `ddlSafety.statementTimeoutSec`, or
  `-- @statement-timeout-sec: N` per file (`0` = no limit for that file), sets
  `max_statement_time` for the migration — a statement running longer is stopped and
  rolled back by the server, never retried. Off by default; not available on MySQL
  (refused before anything runs). A malformed annotation fails validation
  (`INVALID_STATEMENT_TIMEOUT`).
- **Stopping a migration that runs too long**: `docs/DDL-PRODUCTION-SAFETY.md` §7.5 —
  `KILL QUERY` (measured: stopped in ~1 s, table unchanged), and why killing the Pod or
  the client does **not** stop it (the server finishes the ALTER and commits it).
- **MariaDB `ssl` option** (adapter and the Docker entrypoint's wait-for-database
  check): `ssl: true` (verify against Node's default CAs), `ssl: { caFile, certFile,
  keyFile }` (files read for you), or any mysql2 `ssl` object. See
  `docs/USER-GUIDE-MARIADB.md` §7.2.
- **`k8s/dynamic/`**: `submit.sh` creates a suspended Job plus ConfigMaps owned by it,
  runs the pre-flight, then starts it; `run.sh` (in the Pod) runs `sync` then `dcl` and
  waits for the reports to be collected; `collect.sh` fetches them, verifies checksums
  and releases the Pod. Every failure — bad profile, empty migrations directory,
  missing config, Kubernetes errors, DB unreachable — produces an error
  `notification.html` ready to mail; nothing is left suspended in the cluster. Exit
  codes, files and troubleshooting are in its README.
- **`k8s/preflight-check.sh`**: also checks that the migrations ConfigMap isn't empty
  and the config ConfigMap has its files (`REQUIRED_CONFIG_KEYS`, default `config.js`);
  new optional `DB`, `EXCLUDE_JOB`, `SUSPENDED_STALE_SECONDS`.

- **Azure DevOps image built and published with every release**: `Dockerfile.azure` is
  now the `azure` target of `Dockerfile` (same base, so fixes reach both), pushed to
  ghcr.io as `<version>-azure` (`3.0.1-azure`, `3.0-azure`, `latest-azure`) next to the
  default image. It also gets the `/tmp` 1777 fix, which `Dockerfile.azure` had missed.
  See `docs/BUILD-IMAGE-GUIDE.md` (Images).

### Behavior changes

- **`baseline --up-to` / `--file`**: an argument that only matched part of a name now
  fails with "not found" (or "matches N migrations"). Use the full file name or its
  timestamp.
- **Pre-flight `notification.html` is now mode `0600`** (it was `0644`), like the other
  notification files. A mailer running as a different user than the one that ran the
  pre-flight needs access.
- **Pre-flight overlap check**: a Job counts as running until it has a Complete/Failed
  condition (before: only while it had active Pods), so a Job whose Pod hasn't started
  yet now blocks too. A Job suspended for over `SUSPENDED_STALE_SECONDS` (600) that
  never started is ignored with a warning.
- **MariaDB migration errors** from a migration with several statements end with
  `(statement N of M; …)`. The MariaDB error code and the start of the message are
  unchanged.
- **DCL email** may now show `PASSWORD CHANGED` where 3.0.0 showed `NEW`/`NO CHANGE`
  (the cases under Fixed), and a MongoDB account whose password can't be matched shows
  no password.

### Upgrade

1. Use the 3.0.1 image.
2. RDS / TLS-only MariaDB: add `ssl: { caFile: … }` to both DDL and DCL configs and ship
   the CA bundle with them.
3. MongoDB DCL scripts with `CHANGE_ME_ON_FIRST_LOGIN`: make sure `up()` returns
   `allUsernames` listing every such account in file order
   (`users.map(u => u.username)`), as in `docs/DCL-PASSWORD.md`.
4. Scripts calling `baseline --up-to` / `--file` with a partial name: switch to the full
   name or timestamp.

### Caveats

- If a 3.0.0 run hit one of the DCL bugs above, the affected accounts exist with a
  password nobody has: rotate them (`ALTER USER` / `updateUser` R__ script).
- MariaDB TLS was verified against a server with `require_secure_transport=ON` and a
  private CA, not against RDS itself; the privileges the runtime gates need on RDS
  (`PROCESS`) are not verified yet.
- `k8s/dynamic/` isn't used by the CI deploy jobs yet — they still apply `k8s/job.yaml`.

## [3.0.0] - 2026-10-02

Everything since **2.0.0** (2026-07-23, commit `644fa86`). Contains breaking changes —
read the upgrade guide below before switching an environment over.

> `package.json` said `2.1.0` from 2026-09-29 (`07bd065`) until this release, in the
> middle of this work. That number was never a release — images built in that window
> and tagged `2.1.0` are pre-release builds. Compare against 2.0.0.

### TL;DR

- **The tool now refuses instead of guessing.** Pending migrations are validated before
  `up`/`sync`/`up-all` run; a missing database, missing MariaDB credentials, an edited
  already-applied migration, a long-open transaction on the target, or a read-only
  target stop the run before anything executes. Most of these have an explicit,
  logged override.
- **Generated DCL passwords moved from `/tmp/secret` to a notification email**
  (`reports/notification-<runId>.html`). Anything that reads `/tmp/secret` must change.
- **New commands:** `sync` (status → validate → up → schema diff → email) and `reset`.
  **New previews:** `dcl --plan`, `down --dry-run`; `down` now asks for confirmation.
- **The tool's own tables gain one column each** (DDL `checksum`, DCL `content`), added
  automatically on the first writing run — the account needs `ALTER` on them.
- **Node 22.12+** is required (the image ships Node 24).

### Upgrade guide

Do these in order; steps 1–4 change nothing in the database.

1. **Runtime.** Node ≥ 22.12 (`engines` in `package.json`), or use the new image.
   Pin the image to a version tag or commit SHA — `latest` and `main` move on every push
   to `main`.
2. **Configuration.**
   - MariaDB/MySQL: set credentials explicitly (`MARIADB_USER` / `MARIADB_PASSWORD`, or
     `user` / `password` in the config). There is no `root` / `rootpass` fallback.
   - Brand-new environments only: `createDatabaseIfMissing: true`. Otherwise a database
     that doesn't exist is an error (it usually means the wrong host or a typo).
3. **Automation (CI pipelines, Kubernetes Jobs).**
   - `down` shows its plan and waits for `yes`; outside a terminal it **fails without
     `--yes`**.
   - Stop reading `/tmp/secret`. Generated passwords are only in the run's notification
     email, written to `-o <dir>` (default `reports/`) as `notification-<runId>.html`
     plus `notification.html` (latest copy), both mode `0600`. Decide who collects and
     delivers it; delete it once delivered.
   - `sync` exits non-zero when nothing is pending (in a deploy, that usually means
     something upstream is wrong).
4. **Read-only checks** — run against each environment; none of them write:
   - `validate --pending-only -c <config>` — what `up`/`sync` will now validate.
     Migrations that passed under 2.0.0 can fail now (see *Breaking changes*); fix them,
     or allow a reviewed exception with `-- @allow: CODE` in the file.
   - `status -c <config>` — orphaned changelog entries (file deleted/renamed after it was
     applied) and out-of-order applied migrations are reported and block `up`.
   - `dcl:status -c <config>` — DCL scripts recorded as applied but no longer on disk.
     `dcl` refuses until each is restored, or confirmed with `--accept-removed-dcl`.
   - `up --dry-run -c <config>` — also shows whether the runtime gates would refuse.
5. **Before the first writing run,** make sure the migration files match what is really
   applied in that environment: the first run records their current content as the
   checksum baseline (see *The tool's own tables*).
6. **Privileges.** `ALTER` on the tool's tables for the first writing run. For the
   open-transaction check (R2): `PROCESS` (MariaDB/MySQL) or the `clusterMonitor` role
   (MongoDB). Without it the check is skipped with a notice — or refused, if you turn on
   `runtimeGates.requireLockCheck` (recommended for production).
7. **Accounts from old verification runs (MariaDB).** 2.0.0's `dcl:verify` could leave
   accounts whose password was literally `CHANGE_ME_ON_FIRST_LOGIN`. Rotate any account
   created that way.

Going back to 2.0.0 is safe: it ignores the added columns.

### The tool's own tables

No new tables, no renames, record keys unchanged. One column each, added by the first
**writing** command (`up`, `sync`, `down`, `baseline`, `dcl`, …). Read-only commands
(`status`, `--dry-run`, `--plan`, `validate`) never alter anything.

| Table / collection (default name) | Added | Existing records |
|---|---|---|
| MariaDB/MySQL DDL `schema_migrations` | `checksum VARCHAR(64) NULL` | Filled from the migration file **as it is on disk at that first run** — the baseline later edits are checked against. Edits made before the upgrade can't be detected. |
| MongoDB DDL `changelog` | `checksum` field | Same. (A `fileHash` field from migrate-mongo's `useFileHash`, if you enabled it, is no longer read.) |
| DCL `dcl_repeatable_migrations` (both) | `content` (`MEDIUMTEXT NULL` / field) | Stays empty until that script is applied again; until then `dcl --plan` shows no diff for it. |

The DCL table always had `checksum`; the DDL changelog never did before.

### Breaking changes

Things that passed silently in 2.0.0 and now stop the run:

| 2.0.0 | Now |
|---|---|
| `up` / `up-all` ran migrations without validating them | Validated first (same rules as `validate`, only the migrations about to run); any failure refuses the whole run. Reviewed exceptions: `-- @allow: CODE` in the file, `validation.allow` in the config, or `--allow CODE` / `--allow-dangerous` / `--allow-forbidden` for one run — every allowance used is logged. |
| An applied migration file could be edited afterwards, unnoticed | Refused (checksum gate). Accept a reviewed edit with `--allow-checksum-drift`. |
| Changelog entries without a file, or applied out of order, were ignored | Reported; `up`/`sync` refuse (no override — needs a human look). |
| A deleted/renamed DCL script was ignored; its accounts stayed, untracked | `dcl` refuses until restored or confirmed with `--accept-removed-dcl`. |
| A missing database was created automatically | Error unless `createDatabaseIfMissing: true`. |
| MariaDB fell back to `root` / `rootpass` | Error without explicit credentials. |
| The connection wasn't checked against the configured database | Refused if the server reports a different database than configured (R0). |
| Nothing checked the server before executing | Refused on transactions open longer than 60 s or sessions waiting on a metadata lock in the same database (override `--allow-open-transactions`, logged), and on a read-only target (no override). See *New features → Runtime gates*. |
| `down` rolled back immediately; `--target` was ignored | Shows the plan, asks for `yes` (`--yes` when not in a terminal); `--dry-run`; `--target` works; refuses migrations edited since they were applied. |
| MariaDB: a file without `-- +migrate Up` was skipped and stayed pending forever | Rejected (`MISSING_UP_MARKER`). |
| MariaDB: `down` silently skipped a file without a Down section | Error; the migration stays applied. |
| MariaDB: an empty Down only warned | Error when Up has real operations (as on MongoDB). |
| `R__` files in a DDL directory: run as migrations on MongoDB, skipped on MariaDB | Ignored on both, with a warning; old changelog entries for them are reported and left alone. |
| Dangerous-operation rules matched across the whole Up section | Matched per statement. Catches `UPDATE`/`DELETE` without `WHERE` next to one with it, `TRUNCATE t`, `DROP` without `COLUMN`, schema-qualified tables, Mongo `deleteMany()`/`dropCollection()`/`bulkWrite` with empty filters — some migrations that passed now need an `@allow`. |
| MariaDB: `DROP TABLE` of an existing table was `ORPHAN_DROP_UP` | `DROP_TABLE` (data loss). `ORPHAN_DROP_UP` now means the table exists nowhere (likely a typo). |
| MongoDB: `dropDatabase()` in `down()` was auto-allowed if `up()` created a collection | Always needs explicit approval. |
| MongoDB: an apostrophe in a comment or a nested `{ … }` cut the validated `up()` body short | The whole body is validated — may surface operations that were hidden. |
| `DROP DATABASE` in Up was reported under two codes, so allowing `DROP_DATABASE` was never enough | One code per form (`DROP_DATABASE` / `DROP_SCHEMA`; Mongo `DROP_DATABASE` / `DROP_DATABASE_CMD`). |
| `--sanity-check` (MongoDB) ran all pending migrations in one go, skipping later files' checks | Each migration runs with its own Pre/Post-Check; `--target`/`--only` honored. |
| `--sanity-check` (MariaDB) continued after an auto-rolled-back failure | The run stops there. |
| `--target`/`--only` matched the first file *containing* the value | An exact file name wins over a substring match. |
| DCL passwords were appended to `/tmp/secret` | Only in the run's notification email (`0600`); never on disk otherwise, never in logs. |
| Node ≥ 20 | Node ≥ 22.12. |

### New features

All optional settings default to the old behavior unless noted.

**Commands and previews**
- `sync` — status → validate → up → before/after schema diff → current schema, plus a
  notification email; `-o <dir>` also writes a JSON + HTML report.
- `reset` — clears the tool's records (not your data); dry run unless `--yes`.
- `dcl --plan` / `dcl-all --plan` — per changed script: line diff against what was last
  applied, each named account with its current grants, which passwords would be
  generated or rotated. Nothing executes.
- `down --dry-run`, `validate --pending-only`.
- `dcl` prints an account/permission before/after diff.
- Read-only commands really are read-only (`status`, `status-all`, `up`/`up-all`/`down`/
  `baseline --dry-run`, `validate`, `dcl:status`, `dcl:status-all`, `dcl`/`dcl-all
  --plan`/`--dry-run`): they work with a `SELECT`-only account.

**Runtime gates** — checked right before anything executes ([docs/RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md)); `--dry-run` reports what would be refused
- R0 identity, R1 changelog consistency + checksums (DDL and DCL), R2 open transactions /
  metadata-lock waits, R3 writable primary + replication lag, R4 binlog / disk headroom.
- MariaDB **Lock Guard** (`ddlSafety.lockGuard`, on by default): migration SQL runs with
  a bounded lock wait and retries, so an `ALTER` behind a long transaction fails fast
  instead of queueing and blocking every later query on the table. The tool's own
  session is bounded the same way.
- MongoDB **operation time limit** (`ddlSafety.operationTimeoutMs`, off by default), or
  per file `// @operation-timeout-ms: <ms>` (0 = no limit).
- MongoDB **large-collection warning**: an index build or `updateMany`/`deleteMany`/
  `bulkWrite` on a collection with ≥ `runtimeGates.largeCollectionDocs` documents
  (default 1,000,000) is flagged before it runs, with the time limit that applies.
  Never blocks.
- `runtimeGates.requireLockCheck: true` refuses a run whose R2 check couldn't execute
  (missing privilege) instead of skipping it.

**Validation**
- Project policy: `validation.rules: { CODE: 'off' | 'warn' | 'error' }` and
  `validation.customRules` (your own forbidden/dangerous/warning patterns).
- Approvers: `-- @approved-by: <name>` or `--approved-by <name>` records who approved a
  released forbidden operation (run log + "Approved exceptions" in the email);
  `validation.requireApprover: true` makes it mandatory (`APPROVER_REQUIRED`).

**DCL**
- Notification email per run: new / rotated / unchanged / removed accounts, permission
  changes, plaintext password only for new or rotated ones. `dcl-all` writes one per
  instance (its own passwords) plus a password-free `notification-summary.html`.
- `notifications.keepRuns` (default **20**, `0` = keep all) prunes old per-run copies —
  and `sync -o` reports — per file name; the latest copy always stays.
- `migrationsDir` can be a list, e.g. `['./shared', './prod-tw']`: shared accounts plus
  each server's own. The same file name in two directories is rejected; output tags
  each file with its directory; `create-dcl --dir <dir>` picks where a new file goes.

**Operations**
- MySQL 8 is tested in CI alongside MariaDB.
- Kubernetes: example manifests in [`k8s/`](k8s/README.md) for running migrations as a
  Job (ConfigMap/Secret/ServiceAccount, `backoffLimit: 0`, preflight script).
- Container: the entrypoint reads the database type and connection from the config.
  2.0.0 guessed them from the config's *path*, so a config whose path contained neither
  `/mariadb/` nor `/mongodb/` made the container wait ~60 s for the wrong database and
  never run. `scripts/build-migration-image.sh` (always failed in 2.0.0) works.
- Images on GHCR: `ghcr.io/i7ppbeer/db-migrate/db-migrate` — `latest`, `main` and the
  commit SHA on every push to `main`; `X.Y.Z` and `X.Y` for each release tag.

### Security

- `mysql2` 3.16.1 → 3.24.5 (GHSA-3f6p-5ww8-9rcr: auth downgrade could leak the password;
  GHSA-rgwj-5xj2-c3m3: zlib decompression bomb). `npm audit`: 0 vulnerabilities.
- Generated passwords no longer touch `/tmp`; notification files are `0600`; MongoDB DCL
  scripts with resolved passwords go to a private temp directory deleted after loading.

### Other fixes

- DCL: a `CHANGE_ME_ON_FIRST_LOGIN` mentioned in a comment shifted the user/password
  pairing, so emailed passwords didn't work (affected the official templates).
- DCL `applied_at` and DDL `applied_at` shown in the wrong time zone.
- `sync` could hang behind a long transaction: every connect ran
  `CREATE DATABASE IF NOT EXISTS`, which waits on an exclusive schema lock.
- `FK_REFERENCES_DROPPED_TABLE` false positive on drop → recreate → reference.
- MariaDB: a sanity block with two or more `EXPECT_*` directives was rejected by
  validation as a syntax error (they were parsed as one statement) unless the queries
  used `DATABASE()`.

### Documentation

- The MariaDB and MongoDB user guides were checked line by line against the code and
  their examples validated; several taught things that don't work:
  - **Stored procedures (MariaDB)** go in DDL, written **without `DELIMITER`** and with
    `-- @skip-syntax-check: true`. A migration using `DELIMITER //` fails — `DELIMITER`
    is a `mysql` client command, not SQL. DCL refuses procedures outright.
  - **Sanity checks (MongoDB)** are the exported `preCheck()` / `postCheck()` functions,
    which must return `{ success, error }`. Checks written inside `up()` that throw are
    not rolled back.
  - **DCL**: `DROP USER`, `REVOKE`, `ALTER USER` (MariaDB) and `updateUser` /
    `dropUser` (MongoDB) need `@allow-forbidden`; passwords come from
    `CHANGE_ME_ON_FIRST_LOGIN`, never from the file; tables, procedures and data
    cleanup can't live in DCL; a table-level `REVOKE` out of a database-level grant fails.
- Removed `docs/archive/` and the broken draw.io diagrams (replaced by Mermaid).

### Caveats

- The first writing run trusts the files on disk as the checksum baseline (upgrade step 5).
- The large-collection warning only sees collection names written literally in `up()`;
  names built at runtime or reached through `client.db()` aren't checked.
- `operationTimeoutMs` bounds each operation, not a whole migration; a MongoDB migration
  that times out is not rolled back (nor is any failed MongoDB migration).
- Notification emails hold plaintext passwords: keep `-o` on storage only the right
  people can read, and delete files after delivery.

## [2.0.0] - 2026-07-23

Baseline for the notes above (commit `644fa86`). Not documented in this file.

---

## Releasing

1. Move everything under `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section
   (leave an empty `## [Unreleased]` above it). Write it for the team: what changed,
   what's new, how to upgrade, caveats — in English.
2. Set `version` in `package.json` and `.version()` in `src/cli.js` to `X.Y.Z`; merge to
   `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.

CI then checks the tag matches `package.json` **and** that this file has a non-empty
`## [X.Y.Z]` section — otherwise nothing is published — builds and pushes the image
(`X.Y.Z`, `X.Y`, SHA), and creates the GitHub Release from that section.
