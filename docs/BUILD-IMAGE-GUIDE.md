# Build Image Guide for Deploying Migration Files

> ⚠️ **Partially outdated (audited 2026-09-11, Kubernetes section corrected)**:
> - The **Kubernetes Deployment** section has been changed to point at the real, working [`k8s/`](../k8s/README.md) setup (kubectl + ConfigMap/Secret/Job) — the `./charts/db-migrate` Helm chart it originally taught was never actually created.
> - The `azure-pipelines-migrations.yml` referenced in the **Azure DevOps Pipeline** section still **does not exist** (`Dockerfile.azure` does exist, though — it's the image used for the Azure DevOps agent) — that section is unverified; treat it as a draft. If you want to use it, you'll need to write the actual pipeline YAML yourself.
> - `.github/workflows/migrations.yml` has been corrected to match (its build/deploy job also used to reference a nonexistent `Dockerfile.migrations` and Helm chart).
> - `scripts/build-migration-image.sh` was fixed 2026-10-01: it used to build from the same nonexistent `Dockerfile.migrations` / `--target runner` and always failed. It now builds the runner image from `Dockerfile` and bakes migrations in with a generated Dockerfile — the **Local Build** section below reflects that.

This guide explains how to deploy DDL migration files to a Kubernetes production environment using the Build Image approach.

## Table of Contents

1. [Process Overview](#process-overview)
2. [Local Build](#local-build)
3. [CI/CD Automation](#cicd-automation)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [Best Practices](#best-practices)

---

## Process Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Production Deployment Flow                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Developer         CI/CD              Staging        Production    │
│      │                │                   │               │         │
│      │  1. Add migration file & commit    │               │         │
│      │───────────────>│                   │               │         │
│      │                │                   │               │         │
│      │                │  2. Automated test & validate     │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │  3. Build Image (v1.2.3)         │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │  4. Auto-deploy to Staging         │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │                   │  5. Test & validate  │  │
│      │                │                   │──────>│       │         │
│      │                │                   │       │ OK    │         │
│      │                │                   │<──────│       │         │
│      │                │                   │               │         │
│      │                │  6. Deploy to Production after manual approval │
│      │                │──────────────────────────────────>│         │
│      │                │                   │               │         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
your-project/
├── migrations/                    # ✅ Migration files (baked into the image)
│   ├── 20250101000001-create-users.js
│   └── 20250120000001-add-new-column.js  ← Newly added DDL
├── config.js                      # Optional: baked in with -c (credentials stay in env vars)
src/ … Dockerfile …                # db-migrate itself — the runner (base) image
scripts/build-migration-image.sh   # Builds runner image + your migrations
```

Two ways to get migrations to a cluster — pick one:

| | Migrations baked into an image (this guide) | ConfigMap ([`k8s/README.md`](../k8s/README.md)) |
|---|---|---|
| Unit of deployment | One immutable image per migration set | Runner image + a content-hashed ConfigMap |
| Good for | Non-Kubernetes runs, registries as the audit trail | Many projects sharing one runner image |

Both use the same layout inside the container — `/app/migrations/` and `/app/config/config.js` — so commands are identical.

---

## Local Build

### Quick Start

```bash
# 1. Add a migration file
vim migrations/20250120000001-add-user-status.js

# 2. Build the image (builds the db-migrate runner image first if it isn't there)
./scripts/build-migration-image.sh -t v1.0.0 -m ./migrations -c ./config.js

# 3. Check what's in it — no database needed
docker run --rm db-migrate:v1.0.0 validate -c /app/config/config.js

# 4. Run it (credentials from env vars — never baked in)
docker run --rm -e MARIADB_HOST=db.internal -e MARIADB_USER=migrator -e MARIADB_PASSWORD=… \
  db-migrate:v1.0.0 sync -c /app/config/config.js
```

The script refuses to build an image with no migration files in it, and checks after
the build that the image contains exactly the files it found. Inside the image,
`/app/config/migrations` links to `/app/migrations`, so a config using the default
`migrationsDir: './migrations'` works as well as one using `'/app/migrations'`.

Before running a command, the container waits for the database(s) in the given config
to answer (up to ~60s) — using the config's own type, host, port and credentials, every
instance of a multi-instance config — and on timeout prints the last connection error
(e.g. `Access denied …`).

### Build script parameters

```bash
./scripts/build-migration-image.sh [options]

Options:
  -t, --tag          Image tag (default: latest)
  -r, --registry     Registry URL
  -m, --migrations   Migrations directory (default: ./migrations)
  -c, --config       config.js to bake in at /app/config/config.js (optional —
                     otherwise mount one at run time)
  -b, --base         Runner base image (default: db-migrate:<package.json version>,
                     built from ./Dockerfile if it doesn't exist locally)
  -p, --push         Push to registry after build
  -h, --help         Show help
```

### Build examples

```bash
# Build and push to Azure Container Registry
./scripts/build-migration-image.sh -t v1.2.3 -m ./migrations -c ./config.js \
  -r myregistry.azurecr.io -p

# Build and push to GitHub Container Registry, config mounted at run time instead
./scripts/build-migration-image.sh -t v1.2.3 -m ./migrations -r ghcr.io/myorg -p
docker run --rm -v "$(pwd)/config.js:/app/config/config.js:ro" ghcr.io/myorg/db-migrate:v1.2.3 status -c /app/config/config.js
```

---

## CI/CD Automation

### Azure DevOps Pipeline

Uses `azure-pipelines-migrations.yml`:

```yaml
# Key configuration
variables:
  containerRegistry: 'YourAzureContainerRegistry'  # Service Connection
  imageRepository: 'db-migrate'

stages:
  - CI      # Test & validate
  - Build   # Build the image
  - DeployStaging    # Auto-deploy to Staging
  - DeployProduction # Deploy to Production after manual approval
```

#### Setup steps

1. **Create an Azure Container Registry Service Connection**
   - Azure DevOps > Project Settings > Service Connections
   - New > Docker Registry > Azure Container Registry

2. **Create a Kubernetes Service Connection**
   - New > Kubernetes
   - Configure the staging and production connections

3. **Configure Environment Approval**
   - Pipelines > Environments > production
   - Approvals and checks > Add approval

4. **Configure a Variable Group (secrets)**
   - Library > Variable Groups
   - Add `STAGING_DB_PASSWORD`, `PRODUCTION_DB_PASSWORD`

### GitHub Actions

Uses `.github/workflows/migrations.yml`:

```yaml
# Key configuration
env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}/db-migrate

jobs:
  test:           # Test
  build:          # Build & push
  deploy-staging: # Deploy to Staging
  deploy-production:  # Requires manual approval
```

#### Setup steps

1. **Configure Repository Secrets**
   ```
   STAGING_KUBECONFIG     # Staging K8s kubeconfig (base64)
   PRODUCTION_KUBECONFIG  # Production K8s kubeconfig (base64)
   ```

2. **Configure Environments**
   - Settings > Environments
   - Create `staging` and `production`
   - Set Required reviewers on the production environment

---

## Kubernetes Deployment

> ⚠️ **Update, 2026-09-11**: This section used to teach deploying with `helm upgrade ./charts/db-migrate`, but that Helm chart was never actually created — following it as written would just fail. The deploy job in `.github/workflows/migrations.yml` used to make the same mistake and has been fixed alongside this doc. The approach that's actually working today, and that went through a real design discussion, is **kubectl + ConfigMap/Secret/Job** (no Helm). The full example lives in [`k8s/`](../k8s/README.md) and isn't duplicated here — it covers:
> - The Job (including the reasoning for `backoffLimit: 0`, see the warning below)
> - A ConfigMap mounting the migration files (suited to small files shared across multiple projects)
> - A Secret template + which DB account to use
> - ServiceAccount/RBAC
>
> Monitoring the migration run still uses the standard `kubectl wait` / `kubectl logs`; see the "Workflow" section of `k8s/README.md` for examples.

⚠️ **Do not set the Job's `backoffLimit` to anything greater than 0** (an earlier version of this document had an example with `backoffLimit: 5` — that was wrong). A failed DDL migration can leave behind a partial state where "the SQL ran but the changelog wasn't written," and an automatic retry just means the scheduler blindly reruns against an uncertain state. See Section 1.8 of [docs/DDL-PRODUCTION-SAFETY.md](./DDL-PRODUCTION-SAFETY.md) for details. A failure should stop and get a human to look at it, not get handed back to the Job controller for an automatic retry.

---

## Best Practices

### ✅ Recommended practices

| Practice | Notes |
|------|------|
| **Version the image tag** | Use semantic versioning (v1.2.3), not `latest` |
| **Staging before Production** | Validate every change in Staging first |
| **Manual approval for Production** | Use an Environment Approval Gate |
| **Keep validation enabled** | `migration.validation.enabled=true` |
| **Forbid dangerous operations** | `migration.validation.allowDangerous=false` |
| **Retain Job logs** | `ttlSecondsAfterFinished: 86400` |
| **Passwords from Secrets** | Never set passwords in values |

### ❌ Practices to avoid

| Avoid | Why |
|------|------|
| Using the `latest` tag | Can't roll back, hard to track |
| Skipping Staging | Too risky |
| Auto-deploying to Production | Needs human confirmation |
| Editing Production directly | Should go through CI/CD |

### Rollback strategy

Redeploying an older image does **not** undo a migration — the database keeps whatever
already ran. Roll back with `down`, using the image that contains the migration (its
Down section is in there):

```bash
# 1. See exactly what would be rolled back — nothing changes
docker run --rm -e MARIADB_HOST=… -e MARIADB_USER=… -e MARIADB_PASSWORD=… \
  db-migrate:v1.2.3 down -n 1 --dry-run -c /app/config/config.js

# 2. Roll back. Outside a terminal (CI, a Kubernetes Job) down refuses to run
#    without --yes, so the confirmation is an explicit, reviewable flag.
docker run --rm -e MARIADB_HOST=… -e MARIADB_USER=… -e MARIADB_PASSWORD=… \
  db-migrate:v1.2.3 down -n 1 --yes -c /app/config/config.js
```

If a migration failed partway, read the failure notification first: it isn't recorded
as applied, so `down` won't touch it — clean up its partial changes by hand
(see [DDL-PRODUCTION-SAFETY.md](DDL-PRODUCTION-SAFETY.md) §7).

---

## Complete Workflow Example

### Developer adds a migration

```bash
# 1. Create a new migration file
cat > migrations/20250120000001-add-user-status.js << 'EOF'
export const up = async (db) => {
  await db.collection('users').updateMany(
    { status: { $exists: false } },
    { $set: { status: 'active' } }
  );
  await db.collection('users').createIndex({ status: 1 });
};

export const down = async (db) => {
  await db.collection('users').dropIndex('status_1');
  await db.collection('users').updateMany(
    {},
    { $unset: { status: '' } }
  );
};
EOF

# 2. Test locally
npm run test:migration

# 3. Commit & push
git add migrations/
git commit -m "feat: add user status field"
git push origin main
```

### CI/CD runs automatically

1. **CI stage**: automatically runs tests and validation
2. **Build stage**: builds the `db-migrate:v1.2.3` image and pushes it to the registry
3. **Staging deploy**: automatically deploys to the Staging environment
4. **Validation**: confirm the migration succeeded in Staging
5. **Production approval**: approver confirms, which triggers the Production deployment
6. **Production deploy**: deploys to the Production environment

---

## Related Files

- [Dockerfile](../Dockerfile) - Runner (base) image
- [build-migration-image.sh](../scripts/build-migration-image.sh) - Builds runner image + baked-in migrations
- [docker/entrypoint.sh](../docker/entrypoint.sh) / [src/check-db.js](../src/check-db.js) - Container entrypoint and the wait-for-database check
- [.github/workflows/migrations.yml](../.github/workflows/migrations.yml) - GitHub Actions
- [k8s/](../k8s/README.md) - Kubernetes Job manifests (ConfigMap approach)
