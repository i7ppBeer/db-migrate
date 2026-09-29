#!/usr/bin/env bash
# k8s/preflight-check.sh
#
# Run this by the executor/CI, right before generating and applying a
# db-migrate Job (job.yaml) — it checks the two things that otherwise fail
# silently or confusingly instead of surfacing a clear, actionable error:
#
#   1. ConfigMap existence — the Job's volumes reference a migrations
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

mkdir -p "$OUTPUT_DIR"

# $1=error|waiting  $2=title  $3=detail
write_notification() {
  local kind="$1" title="$2" detail="$3" accent bg
  case "$kind" in
    error)   accent="#b0303f"; bg="#fbe8ea" ;;
    waiting) accent="#1f7a8c"; bg="#dff1f3" ;;
  esac
  cat > "$OUTPUT_DIR/notification.html" <<EOF
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Migration Notification</title></head>
<body style="margin:0;padding:0;background:#eef1ee;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef1ee" style="background:#eef1ee;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d7ddd4;">
<tr><td bgcolor="#171b21" style="background:#171b21;padding:18px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:Arial,sans-serif;color:#ffffff;font-size:15px;font-weight:bold;">Migration Notification</td>
<td align="right" style="font-family:Arial,sans-serif;color:#c9cdc6;font-size:12px;">${PROJECT}</td>
</tr></table></td></tr>
<tr><td style="padding:20px 28px 4px;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;">${NAMESPACE} | pre-flight | $(date -u +"%Y-%m-%d %H:%M") UTC</td></tr>
<tr><td style="padding:18px 28px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${bg}" style="background:${bg};border-left:3px solid ${accent};padding:12px 14px;">
<span style="font-family:Arial,sans-serif;font-size:14px;color:#1c211d;font-weight:bold;">${title}</span><br>
<span style="font-family:Arial,sans-serif;font-size:12px;color:#3a3f38;">${detail}</span>
</td></tr></table></td></tr>
<tr><td style="padding:18px 28px 22px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:11px;color:#8a8f86;">This is an automated migration notification. Do not reply.</td></tr>
</table></td></tr></table></body></html>
EOF
  echo "📧 Notification written to $OUTPUT_DIR/notification.html"
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
  echo "✅ ConfigMaps present: $MIGRATIONS_CM, $CONFIG_CM"
}

active_jobs() {
  kubectl get jobs -n "$NAMESPACE" -l "app=db-migrate,project=${PROJECT}" -o json 2>/dev/null \
    | jq -r '.items[] | select((.status.active // 0) > 0) | .metadata.name'
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
