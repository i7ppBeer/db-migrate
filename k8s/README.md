# Running db-migrate in Kubernetes

Example manifests for running this tool as a one-shot `sync` Job against a
real MariaDB, credentials from a Secret, migration files delivered via
ConfigMap (chosen over baking migrations into the image because migrations
are small and this pattern is shared across multiple projects — a separate
derived-image approach would mean rebuilding an image per project per
migration change, which doesn't fit that setup).

These are templates (`{{ project }}`, `{{ namespace }}`, `{{ contentHash }}`
placeholders) meant to be filled in by your CI/CD pipeline or a tool like
Kustomize/Helm — not applied to a cluster as-is.

## Files

| File | Purpose |
|---|---|
| `serviceaccount-rbac.yaml` | ServiceAccount scoped to read exactly one Secret |
| `secret.example.yaml` | Shape of the credentials Secret — **placeholder values only** |
| `configmap-migrations.example.yaml` | Shape of the migrations + config ConfigMaps, with two illustrative sample migrations |
| `job.yaml` | The actual `sync` Job |

## Workflow

1. **Generate the migrations ConfigMap** right before deploying, content-hashed so every deploy references an exact, immutable, traceable set of migrations:
   ```bash
   kubectl create configmap db-migrate-shop-ddl-migrations \
     --from-file=./projects/shop/ddl/migrations \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
   or, preferably, via Kustomize's `configMapGenerator` (auto-hashes the name for you — see the comment in `configmap-migrations.example.yaml`).

2. **Create/update the credentials Secret** from your actual secrets manager (Vault, External Secrets Operator, cloud KMS, sealed-secrets — whatever you already use), not by hand-editing `secret.example.yaml`. See the caution below about which DB user to put in it.

3. **Apply the RBAC and Job**, with your CI/CD pipeline substituting `{{ project }}`, `{{ namespace }}`, `{{ contentHash }}`, and the image tag.

4. **Watch it**:
   ```bash
   kubectl wait --for=condition=complete job/db-migrate-shop-sync-<hash> --timeout=900s -n <namespace>
   kubectl logs job/db-migrate-shop-sync-<hash> -n <namespace>
   ```
   A non-zero exit propagates to the Job's `Failed` condition automatically — `sync` already sets `process.exitCode = 1` on any failure, including the deliberate "0 pending migrations" case (see `docs/DDL-PRODUCTION-SAFETY.md`).

## Why `backoffLimit: 0`

Kubernetes Jobs retry failed Pods by default. A DDL migration that fails
partway through can leave the database in a half-applied state — SQL
executed, changelog not yet written (see
[docs/DDL-PRODUCTION-SAFETY.md](../docs/DDL-PRODUCTION-SAFETY.md) section
1.8). Letting the scheduler automatically retry against that uncertain
state is actively dangerous, not a safety net. A failed sync should stop
and surface to a human, not be silently retried.

## Which DB user goes in the Secret

**Not the database's real superuser**, even though this repo's own
docker-compose defaults use `root` for local-dev convenience. Create a
dedicated `migrator` user scoped to exactly what `sync`/`up` needs on the
target schema (`CREATE`/`ALTER`/`DROP`/`INDEX` on the project's tables,
plus read/write on the changelog table) — separate from the application's
own runtime DB user. Different privilege scope, different rotation
lifecycle, smaller blast radius if either credential ever leaks.

## Pre-flight checklist

`sync` doesn't yet implement the Runtime Gate plan (R0–R4 in
[docs/RUNTIME-GATE-PLAN.md](../docs/RUNTIME-GATE-PLAN.md)) — there's no
automated check today for "is now actually a safe time to run this against
production." Until that exists, run the manual checklist in
[docs/DDL-PRODUCTION-SAFETY.md](../docs/DDL-PRODUCTION-SAFETY.md) section 5
before triggering this Job against a production database.
