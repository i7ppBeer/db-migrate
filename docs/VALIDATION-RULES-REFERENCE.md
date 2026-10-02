# Migration Validation Rules Reference

This file used to hold all validation rules for both adapters in one place. An audit
on 2026-09-10 (against `src/adapters/mariadb-adapter.js` and
`src/adapters/mongodb-adapter.js` directly) found it had drifted from the code —
notably listing a `DROP_TABLE` code that didn't exist at the time (one does now — added
2026-10 for dropping a table an earlier migration created), listing `TRUNCATE_TABLE` as
*forbidden* when it's actually *dangerous*, and using `DELETE_WITHOUT_WHERE` /
`DELETE_FROM` / `UPDATE_WITHOUT_WHERE` where the real codes are `DELETE_ALL` /
`UPDATE_ALL`. Copy-pasting `--allow` codes from the old version of this file would
silently allow nothing.

It's been split into two adapter-specific, code-verified documents:

- **[VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md)** — forbidden /
  dangerous / warning / structural rules, FK integrity validation, syntax-check
  skip conditions.
- **[VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md)** — same, plus the
  differences from MariaDB (JS syntax check method, `missing-down` severity, bracket-
  notation bypass caveat).

If you're re-deriving this content in the future, read the adapter source
(`getValidationRules()` and `validateContent()`), not this file's git history.

---

## Quick reference — shared mechanics

Both adapters follow the same shape:

- **When checks run**: `validate` on demand, and `up` / `sync` / `up-all` **automatically**
  right before executing — on exactly the migrations about to run; if any fails, nothing
  is applied. `validate --pending-only` shows what those commands will check.
- **Severity tiers**: 🔴 forbidden (`--allow-forbidden` / `--allow CODE`) → 🟠 dangerous
  (`--allow-dangerous` / `--allow CODE`) → 🟡 warning (never blocks) → 🔶 performance
  (never blocks). **Structural errors** come in two kinds: single-file false positives
  that *can* be allowed by code (`ORPHAN_DROP_DOWN`, `ORPHAN_DROP_UP`,
  `FK_UNRESOLVED_REFERENCE`), and ones that can only be fixed in the file (syntax errors,
  missing Up/Down, DDL inside a DCL file). Refusal messages say which is which and give
  the exact `--allow` value for the allowable ones.
- **Where allowances live**: a leading comment block in the file (`-- @...` for SQL,
  `// @...` for JS: `@allow-dangerous: true`, `@allow-forbidden: true`,
  `@allow: CODE1,CODE2`, MariaDB-only `@skip-syntax-check: true`), the config's
  `validation.allow: { '<file>': ['CODE'] }` (e.g. for an already-applied file, which
  must not be edited), or CLI flags for one run. All of them only add permission, and
  every allowance used is printed in the run log.
- **String-literal protection**: string/template literal contents never trigger a
  pattern match — a log message containing the words "drop database" is not the same
  as running `DROP DATABASE`. Comments are stripped first, quote-aware.
- **Per statement / whole function**: MariaDB rules are matched per statement of the Up
  section; MongoDB rules against the `up()` body (matched by braces, not regex).
- **DDL vs DCL are mirror-image rule sets**: schema/structure operations are forbidden
  in DCL projects and vice versa, so the two kinds of migration can't accidentally
  leak into each other.

## Recording who approved a forbidden operation

A released 🔴 forbidden operation can name its approver, either in the file's leading
comment block or for one run:

```sql
-- @allow: DROP_DATABASE
-- @approved-by: Alice (CAB-1042)
```

```bash
node src/cli.js sync -c <config> --allow-forbidden --approved-by "Alice (CAB-1042)"
```

The file's `@approved-by` wins over `--approved-by`. The approver is printed next to
each allowance in the run log (`Allowed in <file> [DROP_DATABASE]: … — approved by
Alice (CAB-1042)`, or `(nobody recorded)`), and `sync`'s notification email gets an
**Approved exceptions** section listing each released forbidden operation and who
approved it. `--approved-by` is accepted by `validate`, `validate-all`, `up`, `up-all`,
`sync`, and by `dcl` / `dcl-all` together with `--validate`.

```javascript
// config.js
validation: { requireApprover: true }
```

With `requireApprover` on, a forbidden operation that was allowed **without** an
approver fails validation with `APPROVER_REQUIRED` (nothing is applied); the message
says to add `@approved-by` or pass `--approved-by`. `--allow` can't release it — only a
name can. Dangerous-level (🟠) allowances never need an approver.

`DROP DATABASE` reports exactly one code per form: MariaDB `DROP DATABASE` →
`DROP_DATABASE`, `DROP SCHEMA` → `DROP_SCHEMA`; MongoDB `.dropDatabase()` →
`DROP_DATABASE`, `{ dropDatabase: 1 }` → `DROP_DATABASE_CMD`. (Previously a drop in the
Up section was reported under both codes, so allowing the one shown was never enough.)

## Project policy: turning rules off, down or up, and adding your own

```javascript
// config.js
validation: {
  rules: {
    DROP_INDEX: 'off',            // doesn't apply in this project
    ALTER_TABLE_MODIFY: 'warn',   // reported, never blocks
    PREFER_BIGINT: 'error'        // a warning-level rule that should block
  },
  customRules: [
    { code: 'NO_ENUM', level: 'dangerous', pattern: '\\bENUM\\s*\\(',
      message: 'Use a lookup table instead of ENUM', suggestion: 'Create a reference table' },
    { code: 'PREFER_BIGINT', level: 'warning', pattern: '\\bINT\\s+PRIMARY\\s+KEY',
      message: 'Prefer BIGINT primary keys' }
  ],
  existingTables: ['legacy_users'],                       // MongoDB: existingCollections
  allow: { '20260101000005-drop-legacy.sql': ['DROP_TABLE'] }
}
```

- `customRules[].level` is `forbidden`, `dangerous` or `warning`; `pattern` is a regular
  expression (case-insensitive unless `flags` says otherwise) matched against each Up
  statement (MariaDB) or the `up()` body (MongoDB), with comments and string literals
  removed. Custom forbidden/dangerous rules are released the same ways as built-in
  ones (`@allow: NO_ENUM`, `--allow NO_ENUM`, …).
- `rules` takes `off`, `warn` or `error` per code. `error` turns a coded warning (such as
  a custom `warning` rule) into a blocking, still-allowable dangerous op.
- Not relaxable: `MISSING_UP_MARKER`, `MISSING_UP_EXPORT`, `JS_SYNTAX_ERROR` (the file
  couldn't run) and the DDL-inside-DCL codes (`CREATE_TABLE_IN_DCL`, …).
- Unknown codes, invalid levels and invalid patterns are reported as warnings by
  `validate` and by `up`/`sync` — a typo never silently turns a rule off.

## CLI usage

```bash
node src/cli.js validate -c <config>
node src/cli.js validate -c <config> --allow-dangerous
node src/cli.js validate -c <config> --allow-forbidden
node src/cli.js validate -c <config> --allow ALTER_TABLE_MODIFY,DROP_INDEX
node src/cli.js validate -c <config> --allow-forbidden --approved-by "Alice (CAB-1042)"
```

## Programmatic usage

```javascript
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';

const adapter = new MariaDBAdapter(config);
const result = adapter.validateContent(content, 'migration.sql', {
  allowDangerous: false,
  allowForbidden: false,
  allowedCodes: ['ALTER_TABLE_MODIFY']
});

result.valid;              // boolean
result.errors;              // structural + un-allowed forbidden/dangerous, combined
result.forbiddenOps;        // un-allowed forbidden ops only
result.dangerousOps;        // un-allowed dangerous ops only
result.warnings;            // includes [ALLOWED]/[FORCE ALLOWED] downgrades
result.suspiciousNames;
result.performanceIssues;
result.performanceMetrics;
```
