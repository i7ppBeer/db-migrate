#!/usr/bin/env bash
# k8s/dynamic/submit.sh — create one db-migrate run (Job + its ConfigMaps)
# from a profile directory, and start it.
#
#   JOB=$(IMAGE=registry/db-migrate:3.0.0 ./k8s/dynamic/submit.sh <profile-dir>)
#
# Prints one line on stdout — the run (Job) name — whether it started or not;
# progress goes to stderr. On any failure, $REPORTS_DIR/<run>/notification.html
# explains why (bad profile, empty migration directory, missing config,
# missing Secret, pre-flight), ready to mail as-is.
#
# Steps:
#   1. render job.template.yaml with a fresh RUN_ID, create it suspended
#   2. create this run's ConfigMaps, owned by the Job (deleted with it):
#        <job>-ddl     DDL migration files
#        <job>-dcl     DCL scripts (empty when the profile has none)
#        <job>-config  ddl/dcl config.js, ddl/dcl args, *.pem, run.sh, notification-html.sh
#        <job>-env     the profile's db.env (DB host/URL, no credentials)
#   3. pre-flight check (../preflight-check.sh); on failure delete the Job
#      (its ConfigMaps go with it) and exit with the pre-flight's code
#   4. un-suspend the Job
#
# Profile directory (see examples/):
#   profile.env    PROJECT, DB, NAMESPACE, DDL_SECRET, DDL_DIR, …  (KEY=VALUE, no quotes)
#   db.env         env vars for the container (MARIADB_HOST=… / MONGODB_URL=…)
#   ddl.config.js  required;  ddl.args optional
#   dcl.config.js  optional — no DCL step without it;  dcl.args optional
#   *.pem          optional — TLS CA bundles, mounted as /app/config/<name>.pem
#
# Any profile.env key can be overridden from the environment. Also:
#   IMAGE                    required — the db-migrate image
#   MIGRATE_TIMEOUT_SECONDS  default 1800 — time allowed for DDL + DCL
#   COLLECT_TIMEOUT_SECONDS  default 3600 — time run.sh waits for collect.sh
#   TTL_SECONDS              default 86400 — Job/Pod/ConfigMaps kept after finishing
#   REPORTS_DIR              default ./reports — where a failed submit writes <run>/notification.html
#   WAIT_SECONDS             default 0 — passed to the pre-flight (wait for a running Job)
#
# Exit codes: 0 started · 1 bad profile / empty or missing files / pre-flight found a problem ·
#             2 another db-migrate Job for this project+db is still in progress (retry later)

# -E: the ERR trap set below must also fire inside functions (owned_cm)
set -Eeuo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../notification-html.sh
. "$HERE/../notification-html.sh"
log() { echo "$@" >&2; }

RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$(head -c2 /dev/urandom | od -An -tx1 | tr -d ' \n')"
JOB=""

# The name of this run — the Job name once PROJECT/DB are known. Always the
# one line printed on stdout, success or not, so the caller knows which
# $REPORTS_DIR/<run>/ to look in.
run_name() { echo "${JOB:-db-migrate-${PROJECT:-unknown}-${DB:-unknown}-${RUN_ID}}"; }

# Fail with an error notification.html the caller can mail as-is.
die() {
  local name; name=$(run_name)
  log "❌ $*"
  write_notification_html "${REPORTS_DIR:-./reports}/$name" error "${DIE_TITLE:-Migration not started: invalid deploy configuration}" \
    "$*" "${PROJECT:-unknown}" "${NAMESPACE:-?} | ${DB:-?} | submit | $(date -u +"%Y-%m-%d %H:%M") UTC"
  echo "$name"
  exit 1
}
require() { [ -n "${!1:-}" ] || die "$1 is not set — $2"; }
# A migrations ConfigMap gets the directory's top-level files only
# (kubectl create configmap --from-file=<dir> skips subdirectories), and
# run.sh ignores dot-files — so check, and hash, exactly that set.
shipped_files() { find "$1" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -print0 | sort -z; }
has_files() { [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -print -quit 2>/dev/null)" ]; }
check_migration_dir() {  # <label> <dir> [hint when empty]
  [ -d "$2" ] || die "$1 directory $2 not found"
  local nested
  nested=$(find "$2" -mindepth 2 -type f ! -name '.*' -printf '%P\n' | head -3)
  [ -z "$nested" ] || die "$1 directory $2 has files in subdirectories (${nested//$'\n'/, }) — they would not be shipped; move them to the top level"
  has_files "$2" || die "$1 directory $2 is empty${3:+ ($3)}"
}

for bin in kubectl jq sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || die "submit.sh requires '$bin' on PATH"
done

[ -n "${1:-}" ] || die "usage: submit.sh <profile-dir>"
[ -d "$1" ] || die "profile directory '$1' not found"
PROFILE=$(cd "$1" && pwd)
[ -f "$PROFILE/profile.env" ] || die "$PROFILE/profile.env not found"

# profile.env, without overriding anything already set in the environment
while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key=${line%%=*}; val=${line#*=}
  if [ -z "${!key+x}" ]; then export "$key=$val"; fi
done < "$PROFILE/profile.env"

require PROJECT "add it to $PROFILE/profile.env"
require DB "add it to $PROFILE/profile.env (mariadb or mongodb)"
require NAMESPACE "add it to $PROFILE/profile.env"
require IMAGE "set IMAGE to the db-migrate image to run"
require DDL_SECRET "add it to $PROFILE/profile.env"
require DDL_DIR "add it to $PROFILE/profile.env"
: "${ENVIRONMENT:=}"
: "${MIGRATE_TIMEOUT_SECONDS:=1800}"
: "${COLLECT_TIMEOUT_SECONDS:=3600}"
: "${TTL_SECONDS:=86400}"
: "${REPORTS_DIR:=./reports}"
: "${WAIT_SECONDS:=0}"

case "$DB" in mariadb|mongodb) ;; *) die "DB must be mariadb or mongodb, got '$DB'";; esac

# ── Names ────────────────────────────────────────────────────────
JOB="db-migrate-${PROJECT}-${DB}-${RUN_ID}"
# The Job name becomes the Pod's job-name label, and label values max out at 63
[ ${#JOB} -le 63 ] || die "Job name '$JOB' is ${#JOB} chars (max 63) — shorten PROJECT"
[[ "$JOB" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || die "Job name '$JOB' isn't a valid DNS label — PROJECT must be lowercase letters, digits and '-'"

# ── Profile contents ─────────────────────────────────────────────
[ -f "$PROFILE/ddl.config.js" ] || die "ddl.config.js not found in $PROFILE"
[ -s "$PROFILE/ddl.config.js" ] || die "ddl.config.js in $PROFILE is empty"
[ -f "$PROFILE/db.env" ] || die "db.env not found in $PROFILE"

abs() { case "$1" in /*) echo "$1";; *) echo "$PROFILE/$1";; esac; }
DDL_DIR=$(abs "$DDL_DIR")
check_migration_dir "DDL migration" "$DDL_DIR"

HAS_DCL=false
if [ -f "$PROFILE/dcl.config.js" ]; then
  HAS_DCL=true
  [ -s "$PROFILE/dcl.config.js" ] || die "dcl.config.js in $PROFILE is empty"
  require DCL_SECRET "add it to $PROFILE/profile.env (the profile has a dcl.config.js)"
  require DCL_DIR "add it to $PROFILE/profile.env (the profile has a dcl.config.js)"
  DCL_DIR=$(abs "$DCL_DIR")
  check_migration_dir "DCL script" "$DCL_DIR" "remove dcl.config.js to run DDL only"
else
  DCL_SECRET=$DDL_SECRET   # mounted but unused — run.sh skips DCL without dcl.config.js
fi

for s in "$DDL_SECRET" "$DCL_SECRET"; do
  kubectl get secret "$s" -n "$NAMESPACE" >/dev/null 2>&1 \
    || die "Secret '$s' not found in namespace '$NAMESPACE' — create it first (keys: username, password)"
done

dir_hash() {  # content hash of a directory's files, for traceability
  [ -n "${1:-}" ] || { echo none; return; }
  (cd "$1" && shipped_files . | xargs -0 -r sha256sum) | sha256sum | cut -c1-12
}
DDL_HASH=$(dir_hash "$DDL_DIR")
DCL_HASH=$(dir_hash "$([ "$HAS_DCL" = true ] && echo "$DCL_DIR")")

# ── 1. Job, suspended ────────────────────────────────────────────
# From here on, any failure — or an interrupt — deletes the Job. A Job left
# suspended would never finish and would block later runs for this
# project+db at pre-flight.
cleanup_on_error() {
  log "   deleting Job $JOB (its ConfigMaps are deleted with it)"
  kubectl delete job "$JOB" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
# kubectl errors from here on are kept in $KERR (not shown as they happen) so
# the failure email can quote them; die() prints the same text to stderr.
KERR=$(mktemp)
STEP=""
fail_and_cleanup() {
  trap - ERR INT TERM
  local detail
  detail=$(grep -v '^[[:space:]]*$' "$KERR" | tail -3 | tr '\n' ' ')
  rm -f "$KERR"
  cleanup_on_error
  DIE_TITLE="Migration not started: Kubernetes error" die "$1${detail:+ — $detail}"
}
trap 'fail_and_cleanup "$STEP failed in namespace $NAMESPACE"' ERR
trap 'fail_and_cleanup "submit.sh was interrupted while $STEP"' INT TERM

log "▶ Creating Job $JOB (suspended)"
STEP="creating Job $JOB"
sed \
  -e "s|{{ job }}|$JOB|g" \
  -e "s|{{ namespace }}|$NAMESPACE|g" \
  -e "s|{{ project }}|$PROJECT|g" \
  -e "s|{{ db }}|$DB|g" \
  -e "s|{{ runId }}|$RUN_ID|g" \
  -e "s|{{ environment }}|$ENVIRONMENT|g" \
  -e "s|{{ ddlHash }}|$DDL_HASH|g" \
  -e "s|{{ dclHash }}|$DCL_HASH|g" \
  -e "s|{{ image }}|$IMAGE|g" \
  -e "s|{{ ddlSecret }}|$DDL_SECRET|g" \
  -e "s|{{ dclSecret }}|$DCL_SECRET|g" \
  -e "s|{{ collectTimeoutSeconds }}|$COLLECT_TIMEOUT_SECONDS|g" \
  -e "s|{{ activeDeadlineSeconds }}|$((MIGRATE_TIMEOUT_SECONDS + COLLECT_TIMEOUT_SECONDS))|g" \
  -e "s|{{ ttlSeconds }}|$TTL_SECONDS|g" \
  "$HERE/job.template.yaml" | kubectl create -f - >&2 2>>"$KERR"
JOB_UID=$(kubectl get job "$JOB" -n "$NAMESPACE" -o jsonpath='{.metadata.uid}' 2>>"$KERR")

# ── 2. ConfigMaps, owned by the Job ──────────────────────────────
owned_cm() {  # name, then kubectl create configmap args
  local name=$1; shift
  STEP="creating ConfigMap $name"
  kubectl create configmap "$name" -n "$NAMESPACE" "$@" --dry-run=client -o json 2>>"$KERR" \
    | jq --arg job "$JOB" --arg uid "$JOB_UID" --arg run "$RUN_ID" '
        .metadata.ownerReferences = [{apiVersion: "batch/v1", kind: "Job", name: $job, uid: $uid}]
        | .metadata.labels = {app: "db-migrate", "db-migrate/run-id": $run}
        | .immutable = true' \
    | kubectl create -f - >&2 2>>"$KERR"
}

log "▶ Creating ConfigMaps"
owned_cm "$JOB-ddl" --from-file="$DDL_DIR"
if [ "$HAS_DCL" = true ]; then owned_cm "$JOB-dcl" --from-file="$DCL_DIR"; else owned_cm "$JOB-dcl"; fi

config_args=(--from-file=run.sh="$HERE/run.sh" --from-file=notification-html.sh="$HERE/../notification-html.sh" --from-file=ddl.config.js="$PROFILE/ddl.config.js")
required_keys="run.sh notification-html.sh ddl.config.js"
if [ -f "$PROFILE/ddl.args" ]; then config_args+=(--from-file=ddl.args="$PROFILE/ddl.args"); fi
# TLS CA bundles (e.g. RDS global-bundle.pem) → /app/config/<name>.pem, for ssl: { caFile }
for pem in "$PROFILE"/*.pem; do
  if [ -f "$pem" ]; then config_args+=(--from-file="$(basename "$pem")=$pem"); fi
done
if [ "$HAS_DCL" = true ]; then
  config_args+=(--from-file=dcl.config.js="$PROFILE/dcl.config.js")
  required_keys+=" dcl.config.js"
  if [ -f "$PROFILE/dcl.args" ]; then config_args+=(--from-file=dcl.args="$PROFILE/dcl.args"); fi
fi
owned_cm "$JOB-config" "${config_args[@]}"
owned_cm "$JOB-env" --from-env-file="$PROFILE/db.env"

# ── 3. Pre-flight ────────────────────────────────────────────────
log "▶ Pre-flight"
STEP="running the pre-flight check"
pf=0
PROJECT="$PROJECT" NAMESPACE="$NAMESPACE" DB="$DB" EXCLUDE_JOB="$JOB" \
MIGRATIONS_CM="$JOB-ddl" CONFIG_CM="$JOB-config" REQUIRED_CONFIG_KEYS="$required_keys" \
OUTPUT_DIR="$REPORTS_DIR/$JOB" WAIT_SECONDS="$WAIT_SECONDS" \
  bash "$HERE/../preflight-check.sh" >&2 || pf=$?
if [ $pf -ne 0 ]; then
  # pre-flight already wrote notification.html explaining why — keep it
  trap - ERR INT TERM
  rm -f "$KERR"
  log "❌ Pre-flight failed (exit $pf) — notification: $REPORTS_DIR/$JOB/notification.html"
  cleanup_on_error
  echo "$JOB"
  exit $pf
fi

# ── 4. Start ─────────────────────────────────────────────────────
STEP="starting Job $JOB"
kubectl patch job "$JOB" -n "$NAMESPACE" --type=merge -p '{"spec":{"suspend":false}}' >/dev/null 2>>"$KERR"
trap - ERR INT TERM
rm -f "$KERR"
log "✅ Started $JOB (ddl-hash $DDL_HASH, dcl-hash $DCL_HASH)"
echo "$JOB"
