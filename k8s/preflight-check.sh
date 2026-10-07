#!/usr/bin/env bash
# k8s/preflight-check.sh
#
# Run this by the executor/CI, right before generating and applying a
# db-migrate Job (job.yaml) — it checks the two things that otherwise fail
# silently or confusingly instead of surfacing a clear, actionable error:
#
#   1. ConfigMap existence and contents (migration files present, config
#      file present) — the Job's volumes reference a migrations
#      ConfigMap (content-hashed name) and a config ConfigMap. If either is
#      missing, the Pod doesn't fail cleanly: it sits in ContainerCreating
#      with a "configmap ... not found" event, the main container never
#      starts, and db-migrate's own error handling / notification email
#      never runs, because nothing inside the container ever executes. This
#      check catches that BEFORE the Job exists.
#
#   2. Job overlap — is a db-migrate Job for this same project/namespace
#      still running? Two DDL Jobs racing against the same database is
#      exactly the class of problem Lock Guard (docs/LOCK-GUARD.md) and the
#      Runtime Gate plan (docs/RUNTIME-GATE-PLAN.md) exist to prevent — this
#      check stops it one layer earlier, before a second Job is even created.
#
# On either failure, writes a standalone notification.html (same visual
# language as reporter.js's notificationEmailToHTML — single style, inline
# styles, mail-client-safe) to $OUTPUT_DIR, so whatever already emails
# reports/notification.html after a normal dcl/sync Job run (see
# docs/DCL-PASSWORD.md) picks this one up exactly the same way. This script
# does not send email itself — it only ever produces that one file.
#
# Required:
#   PROJECT          e.g. shop
#   NAMESPACE         e.g. production
#   MIGRATIONS_CM     the exact, content-hashed ConfigMap name for this
#                      deploy (no sane default — content hash changes every
#                      deploy, see k8s/README.md workflow step 1)
# Optional:
#   CONFIG_CM         default: db-migrate-$PROJECT-config
#   OUTPUT_DIR        default: ./reports
#   WAIT_SECONDS      default: 0 (fail fast). Set >0 to poll instead of
#                      failing immediately if a previous Job is still active.
#   DB                narrows the overlap check to Jobs labelled db=$DB (plus
#                      Jobs with no db label, e.g. k8s/job.yaml, which could
#                      be on any DB), so a project's MariaDB and MongoDB runs
#                      don't block each other
#   SUSPENDED_STALE_SECONDS  default: 600 — a Job suspended and never started for
#                      longer than this is reported but no longer blocks
#   REQUIRED_CONFIG_KEYS  default: config.js — space-separated keys CONFIG_CM
#                      must contain (dynamic/submit.sh: ddl.config.js run.sh …)
#   EXCLUDE_JOB       a Job to leave out of the overlap check — the caller's
#                      own Job when it was created (suspended) before this check
#                      (k8s/dynamic/submit.sh)
#
# "Still active" means not yet finished (no Complete/Failed condition) —
# including a suspended Job, so two runs submitted at the same moment see each
# other and both stop, instead of both starting.
#
# Example:
#   PROJECT=shop NAMESPACE=production \
#   MIGRATIONS_CM=db-migrate-shop-ddl-migrations-a1b2c3d \
#   ./k8s/preflight-check.sh

set -euo pipefail

for bin in kubectl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "❌ preflight-check.sh requires '$bin' on PATH" >&2; exit 1; }
done

: "${PROJECT:?PROJECT is required}"
: "${NAMESPACE:?NAMESPACE is required}"
: "${MIGRATIONS_CM:?MIGRATIONS_CM is required (the content-hashed ConfigMap name for this deploy)}"
: "${CONFIG_CM:=db-migrate-${PROJECT}-config}"
: "${OUTPUT_DIR:=./reports}"
: "${WAIT_SECONDS:=0}"
: "${DB:=}"
: "${EXCLUDE_JOB:=}"
: "${SUSPENDED_STALE_SECONDS:=600}"
: "${REQUIRED_CONFIG_KEYS:=config.js}"

mkdir -p "$OUTPUT_DIR"

# shellcheck source=notification-html.sh
. "$(dirname "$0")/notification-html.sh"

# $1=error|waiting  $2=title  $3=detail
write_notification() {
  write_notification_html "$OUTPUT_DIR" "$1" "$2" "$3" "$PROJECT" "${NAMESPACE} | pre-flight | $(date -u +"%Y-%m-%d %H:%M") UTC"
}

check_configmaps() {
  local missing=()
  local cm
  for cm in "$MIGRATIONS_CM" "$CONFIG_CM"; do
    if ! kubectl get configmap "$cm" -n "$NAMESPACE" >/dev/null 2>&1; then
      missing+=("$cm")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "❌ Missing ConfigMap(s) in namespace '$NAMESPACE': ${missing[*]}" >&2
    write_notification "error" "Configuration not found" \
      "Expected ConfigMap(s) not found in namespace '${NAMESPACE}': ${missing[*]}. Please confirm the deploy configuration is correct before retrying."
    exit 1
  fi
  # Present but empty, or without the config file the Job runs with — the
  # Pod would start and then fail (or worse, find "nothing pending").
  local problems=() keys key
  keys=$(kubectl get configmap "$MIGRATIONS_CM" -n "$NAMESPACE" -o json | jq -r '(.data // {}) + (.binaryData // {}) | keys[]')
  [ -n "$keys" ] || problems+=("ConfigMap $MIGRATIONS_CM has no migration files")
  keys=$(kubectl get configmap "$CONFIG_CM" -n "$NAMESPACE" -o json | jq -r '(.data // {}) | keys[]')
  for key in $REQUIRED_CONFIG_KEYS; do
    grep -qxF "$key" <<<"$keys" || problems+=("ConfigMap $CONFIG_CM has no $key")
  done
  if [ ${#problems[@]} -gt 0 ]; then
    local joined
    joined=$(printf '%s; ' "${problems[@]}"); joined=${joined%; }
    echo "❌ $joined" >&2
    write_notification "error" "Configuration is empty or incomplete" \
      "$joined. Please check the deploy configuration (migration directory and config files) before retrying."
    exit 1
  fi
  echo "✅ ConfigMaps present: $MIGRATIONS_CM, $CONFIG_CM"
}

# Unfinished db-migrate Jobs for this project (and DB), as "<name> <kind>"
# lines — kind "running", or "stale" for a Job that has sat suspended, never
# started, for over SUSPENDED_STALE_SECONDS (left behind by a submit that
# died between creating and starting it; it would otherwise block every
# later run, since a suspended Job never finishes and no deadline or TTL
# applies to it). A Job with no db label (k8s/job.yaml) counts for every DB.
unfinished_jobs() {
  kubectl get jobs -n "$NAMESPACE" -l "app=db-migrate,project=${PROJECT}" -o json 2>/dev/null \
    | jq -r --arg self "$EXCLUDE_JOB" --arg db "$DB" --argjson stale "$SUSPENDED_STALE_SECONDS" '.items[]
        | select(.metadata.name != $self)
        | select($db == "" or ((.metadata.labels.db // "") as $d | $d == "" or $d == $db))
        | select([.status.conditions[]? | select((.type == "Complete" or .type == "Failed") and .status == "True")] | length == 0)
        | (if (.spec.suspend == true) and ((.status.active // 0) == 0) and (.status.startTime == null)
              and (now - (.metadata.creationTimestamp | fromdateiso8601) > $stale)
           then "stale" else "running" end) as $kind
        | "\(.metadata.name) \($kind)"'
}

active_jobs() {
  local all stale
  all=$(unfinished_jobs)
  stale=$(awk '$2 == "stale" {print $1}' <<<"$all")
  if [ -n "$stale" ]; then
    echo "⚠️  Ignoring Job(s) suspended for over ${SUSPENDED_STALE_SECONDS}s that never started (left by an interrupted submit): ${stale//$'\n'/, }" >&2
    echo "   Delete with: kubectl delete job -n $NAMESPACE ${stale//$'\n'/ }" >&2
  fi
  awk '$2 == "running" {print $1}' <<<"$all"
}

check_no_active_job() {
  local jobs waited=0
  jobs="$(active_jobs)"

  if [ -z "$jobs" ]; then
    echo "✅ No other db-migrate Job currently active for project '${PROJECT}'"
    return 0
  fi

  echo "⏳ Job(s) still running for '${PROJECT}': $jobs"
  if [ "$WAIT_SECONDS" -gt 0 ]; then
    echo "   Waiting up to ${WAIT_SECONDS}s for it to finish..."
    while [ -n "$jobs" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do
      sleep 10
      waited=$((waited + 10))
      jobs="$(active_jobs)"
    done
    if [ -z "$jobs" ]; then
      echo "✅ Previous Job finished after ${waited}s — proceeding."
      return 0
    fi
  fi

  # Exit 2 (not 1) — this is a transient, retryable condition, not a
  # misconfiguration; a caller can tell the two apart from the exit code.
  write_notification "waiting" "A previous migration is still running" \
    "Job(s) still active for project '${PROJECT}' in namespace '${NAMESPACE}': ${jobs//$'\n'/, }. This run was skipped to avoid two migrations running against the same database at once. Please retry once it completes."
  exit 2
}

check_configmaps
check_no_active_job
echo "✅ Pre-flight checks passed — safe to apply the Job."
