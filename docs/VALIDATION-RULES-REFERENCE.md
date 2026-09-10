# Migration Validation Rules Reference

This file used to hold all validation rules for both adapters in one place. An audit
on 2026-09-10 (against `src/adapters/mariadb-adapter.js` and
`src/adapters/mongodb-adapter.js` directly) found it had drifted from the code —
notably listing a `DROP_TABLE` code that doesn't exist, listing `TRUNCATE_TABLE` as
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

- **Severity tiers**: 🔴 forbidden (`--allow-forbidden` / `--allow CODE`) → 🟠 dangerous
  (`--allow-dangerous` / `--allow CODE`) → 🟡 warning (never blocks) → 🔶 performance
  (never blocks). A fourth class, **structural errors** (syntax errors, orphan drops,
  FK integrity), is **never bypassable** by any flag or annotation.
- **Annotations**: a leading comment block (`-- @...` for SQL, `// @...` for JS) can
  set `@allow-dangerous: true`, `@allow-forbidden: true`, `@allow: CODE1,CODE2`, and
  (MariaDB only) `@skip-syntax-check: true`. Annotations can only escalate permission —
  they never downgrade a CLI flag.
- **String-literal protection**: string/template literal contents never trigger a
  pattern match — a log message containing the words "drop database" is not the same
  as running `DROP DATABASE`.
- **DDL vs DCL are mirror-image rule sets**: schema/structure operations are forbidden
  in DCL projects and vice versa, so the two kinds of migration can't accidentally
  leak into each other.

## CLI usage

```bash
node src/cli.js validate -c <config>
node src/cli.js validate -c <config> --allow-dangerous
node src/cli.js validate -c <config> --allow-forbidden
node src/cli.js validate -c <config> --allow ALTER_TABLE_MODIFY,DROP_INDEX
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
