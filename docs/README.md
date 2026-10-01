# Documentation

Start with the repo's [README](../README.md) (what the tool does, every command and config
option) and [QUICKSTART](../QUICKSTART.md) (task-by-task walkthrough). The documents below go
deeper, grouped by what you're trying to do.

## Writing migrations

| Document | Covers |
|---|---|
| [USER-GUIDE-MARIADB.md](USER-GUIDE-MARIADB.md) | Writing MariaDB DDL/DCL files: file types, Up/Down sections, sanity-check blocks, examples |
| [USER-GUIDE-MONGODB.md](USER-GUIDE-MONGODB.md) | The same for MongoDB (`up()`/`down()`, `preCheck`/`postCheck`) |
| [VALIDATION-RULES-REFERENCE.md](VALIDATION-RULES-REFERENCE.md) | How validation works for both databases, allowances, **per-project rule policy and custom rules** |
| [VALIDATION-RULES-MARIADB.md](VALIDATION-RULES-MARIADB.md) | Every MariaDB rule code, FK integrity, cross-file drops |
| [VALIDATION-RULES-MONGODB.md](VALIDATION-RULES-MONGODB.md) | Every MongoDB rule code and how `up()` is scanned |
| [DCL-PASSWORD.md](DCL-PASSWORD.md) | `CHANGE_ME_ON_FIRST_LOGIN` generated passwords and the run notification emails |

## Running migrations

| Document | Covers |
|---|---|
| [CLI-USAGE-GUIDE.md](CLI-USAGE-GUIDE.md) | Every command in `node` and `docker compose run` form, targeting, what stops a run |
| [DOCKER-COMPOSE-USER-GUIDE.md](DOCKER-COMPOSE-USER-GUIDE.md) | Step-by-step DCL and DDL workflows with `docker compose` |
| [E2E-SCENARIOS.md](E2E-SCENARIOS.md) | Q&A with flowcharts: create/remove an account, change a schema, onboard a database |
| [MULTI-INSTANCE.md](MULTI-INSTANCE.md) | Many databases from one config, different accounts per instance |
| [EXISTING-DATABASE-ONBOARDING.md](EXISTING-DATABASE-ONBOARDING.md) | Bringing an existing database under the tool with `baseline` |

## Production safety

| Document | Covers |
|---|---|
| [DDL-PRODUCTION-SAFETY.md](DDL-PRODUCTION-SAFETY.md) | **Start here for production** — what jams a database, the protections, pre-flight checklist, abort/rollback runbook |
| [RUNTIME-GATE-PLAN.md](RUNTIME-GATE-PLAN.md) | The checks made before anything executes (R0–R4) and why each is absolute or overridable |
| [LOCK-GUARD.md](LOCK-GUARD.md) | MariaDB lock-wait guard: settings, behavior, limits |

## Deploying

| Document | Covers |
|---|---|
| [../k8s/README.md](../k8s/README.md) | Running `sync` as a Kubernetes Job, migrations from a ConfigMap, enabling the CI deploy jobs |
| [BUILD-IMAGE-GUIDE.md](BUILD-IMAGE-GUIDE.md) | Baking migrations into an image with `scripts/build-migration-image.sh` |

## Testing this tool

| Document | Covers |
|---|---|
| [TESTING-GUIDE.md](TESTING-GUIDE.md) | Running tests locally, `test-all`, fixture expectations (`@expect-error`, `@expect-sanity`), what runs against real databases in CI |
| [CI-MIGRATION-TEST-GUIDE.md](CI-MIGRATION-TEST-GUIDE.md) | `scripts/ci-migration-test.sh`, an alternative driver for CI systems other than this repo's GitHub Actions |

## Archive

[archive/](archive/README.md) — superseded or never-implemented documents, kept for history only.
