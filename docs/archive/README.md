# Archive

Documents moved here are either superseded by more current, verified docs
elsewhere in `docs/`, or describe something not actually implemented in
this repo. Kept for historical/design-rationale context, not as operational
guidance — don't follow instructions from these files without checking
them against the current source or the docs they've been superseded by.

| File | Why it's here | Current equivalent |
|---|---|---|
| `MIGRATION-MANAGEMENT-GUIDE.md` | Original planning document; references a pre-refactor `src/testers/`/`src/validators/` architecture that no longer exists | [CLI-USAGE-GUIDE.md](../CLI-USAGE-GUIDE.md), [VALIDATION-RULES-MARIADB.md](../VALIDATION-RULES-MARIADB.md), [VALIDATION-RULES-MONGODB.md](../VALIDATION-RULES-MONGODB.md), [DDL-PRODUCTION-SAFETY.md](../DDL-PRODUCTION-SAFETY.md) |
| `VAULT-BOUNDARY-GUIDE.md` | Conceptual introduction to Vault/Boundary as external tools — this repo has no Vault/Boundary integration code | N/A — nothing in this repo implements this yet |
| `LOCAL-TEST-GUIDE.md` | Overlapped `TESTING-GUIDE.md`; its quick start and troubleshooting were merged there (2026-10-01) | [TESTING-GUIDE.md § Running tests locally](../TESTING-GUIDE.md#running-tests-locally) |
| `MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md` | Pre-development "Working Backwards" press release/FAQ written to pin down the product vision — not usage documentation, and some of what it promised was built differently | [README.md](../../README.md) for what the tool actually does |
