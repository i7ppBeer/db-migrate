#!/usr/bin/env bash
# k8s/dynamic/collect.sh — fetch a run's reports out of its Pod, then let the
# Pod finish.
#
#   ./k8s/dynamic/collect.sh <job> [namespace]
#
#   1. waits for the Pod's /app/reports/.ready (run.sh writes it after DDL+DCL)
#   2. copies /app/reports to $REPORTS_DIR/<job>/ (tar over kubectl exec)
#   3. verifies every file against the Pod's SHA256SUMS
#   4. creates /app/reports/.collected — run.sh sees it and exits
#   5. waits for the Job to finish and exits with the run's exit code
#
# Collected files ($REPORTS_DIR/<job>/):
#   result.json                     ddl/dcl status + the run's rc
#   ddl/notification.html           DDL email body (always present once the Pod ran)
#   ddl/sync-report-<ts>.html|json  full schema diff + current schema (when sync got that far)
#   dcl/notification.html           DCL email — PLAINTEXT PASSWORDS; only when DCL changed/failed
#
# Env: REPORTS_DIR (default ./reports), READY_TIMEOUT_SECONDS (default 1800 —
#      how long to wait for .ready; match the Job's MIGRATE_TIMEOUT_SECONDS),
#      FINISH_TIMEOUT_SECONDS (default 120 — how long to wait for the Job to
#      finish after releasing it)
#
# Exit codes: the run's own (0 applied · 1 failed · 3 nothing to do), or
#             10 collect.sh itself failed (Pod gone, timeout, checksum mismatch, a
#                kubectl error) — if $REPORTS_DIR/<job>/result.json exists, the
#                reports were saved and it says how the migration went

set -euo pipefail

JOB=${1:?usage: collect.sh <job> [namespace]}
NS=${2:-${NAMESPACE:-default}}
: "${REPORTS_DIR:=./reports}"
: "${READY_TIMEOUT_SECONDS:=1800}"
OUT="$REPORTS_DIR/$JOB"

log() { echo "$@" >&2; }
fail() { log "❌ $*"; exit 10; }

for bin in kubectl sha256sum tar; do
  command -v "$bin" >/dev/null 2>&1 || fail "collect.sh requires '$bin' on PATH"
done

job_finished() {  # prints Complete / Failed, or nothing while still running
  kubectl get job "$JOB" -n "$NS" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{"\n"}{end}' 2>/dev/null \
    | grep -E '^(Complete|Failed)$' | head -1 || true
}

# ── 1. Wait for the Pod and .ready ──────────────────────────────
deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
POD=""
log "⏳ Waiting for $JOB to finish DDL/DCL…"
while :; do
  [ $SECONDS -lt $deadline ] || fail "$JOB: reports not ready within ${READY_TIMEOUT_SECONDS}s"
  kubectl get job "$JOB" -n "$NS" >/dev/null 2>&1 || fail "Job $JOB not found in namespace $NS"
  if [ -z "$POD" ]; then
    POD=$(kubectl get pod -n "$NS" -l job-name="$JOB" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  if [ -n "$POD" ]; then
    phase=$(kubectl get pod "$POD" -n "$NS" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    case "$phase" in
      Running)
        kubectl exec -n "$NS" "$POD" -c migrate -- test -e /app/reports/.ready 2>/dev/null && break ;;
      Succeeded|Failed)
        fail "Pod $POD already ended ($phase) before its reports were collected — see: kubectl logs -n $NS $POD" ;;
    esac
  fi
  [ -z "$(job_finished)" ] || fail "Job $JOB finished before its reports were collected"
  sleep 5
done

# ── 2-3. Copy and verify ────────────────────────────────────────
mkdir -p "$OUT"
chmod 700 "$OUT"   # the DCL email holds plaintext passwords
kubectl exec -n "$NS" "$POD" -c migrate -- tar cf - -C /app/reports . | tar xf - -C "$OUT" \
  || fail "copying the reports out of $POD failed — retry collect.sh"
(cd "$OUT" && sha256sum -c --quiet SHA256SUMS) || fail "checksum mismatch in $OUT — not releasing the Pod; retry collect.sh"

log "📥 Reports saved to $OUT"

# ── 4. Release the Pod ──────────────────────────────────────────
# Every failure from here on is 10 ("couldn't collect"), never kubectl's own
# exit 1 — 1 means "the migration failed". The reports are already saved, so
# result.json in $OUT still says how the migration went.
kubectl exec -n "$NS" "$POD" -c migrate -- touch /app/reports/.collected \
  || fail "reports are saved in $OUT, but releasing Pod $POD failed — retry collect.sh, or the Pod ends on its own after COLLECT_TIMEOUT_SECONDS (exit 4)"

# ── 5. Wait for the Job, exit with the run's code ───────────────
# run.sh checks for .collected every 5s, so the Job finishes within seconds
: "${FINISH_TIMEOUT_SECONDS:=120}"
finish_deadline=$((SECONDS + FINISH_TIMEOUT_SECONDS))
while [ -z "$(job_finished)" ]; do
  kubectl get job "$JOB" -n "$NS" >/dev/null 2>&1 \
    || fail "Job $JOB disappeared before it finished — reports are saved in $OUT (see result.json)"
  [ $SECONDS -lt $finish_deadline ] \
    || fail "Job $JOB did not finish within ${FINISH_TIMEOUT_SECONDS}s of being released — reports are saved in $OUT (see result.json)"
  sleep 2
done
rc=$(kubectl get pod "$POD" -n "$NS" -o jsonpath='{.status.containerStatuses[?(@.name=="migrate")].state.terminated.exitCode}' 2>/dev/null) \
  || fail "Job $JOB finished but its exit code could not be read — reports are saved in $OUT (see result.json)"
[ -n "$rc" ] || fail "Job $JOB finished but its Pod reports no exit code — reports are saved in $OUT (see result.json)"
log "$(cat "$OUT/result.json")"
log "Job $JOB: $(job_finished), exit $rc"
exit "$rc"
