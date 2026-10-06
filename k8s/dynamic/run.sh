#!/bin/bash
# k8s/dynamic/run.sh — runs INSIDE the Job's container (mounted from the
# run's config ConfigMap as /app/config/run.sh).
#
#   1. DDL: sync  -c /app/config/ddl.config.js -o /app/reports/ddl  <ddl.args>
#   2. DCL: dcl   -c /app/config/dcl.config.js -o /app/reports/dcl  <dcl.args>
#      — only if DDL applied or had nothing pending, and only if the profile
#        has a dcl.config.js
#   3. writes /app/reports/result.json + SHA256SUMS, then .ready
#   4. waits (up to COLLECT_TIMEOUT_SECONDS) for an external collector to
#      create /app/reports/.collected, then exits with the run's result
#
# Whenever a step can't produce db-migrate's own email (empty ConfigMap,
# missing config.js, bad args, DB unreachable), an error notification.html is
# written in its place — so ddl/notification.html always exists, and
# dcl/notification.html exists whenever DCL changed something or failed.
#
# Exit codes: 0 something was applied, nothing failed
#             1 DDL or DCL failed (or refused to run)
#             3 nothing to do — no pending DDL and no DCL change
#             4 reports were not collected in time (DCL passwords in them are lost)
#           143 terminated (Job deleted / deadline)

set -u

R=/app/reports
EP=/app/docker/entrypoint.sh   # waits for the DB, then runs the command
mkdir -p "$R/ddl" "$R/dcl"

# Error emails for problems db-migrate itself never gets to report
# (shipped next to this script in the run's config ConfigMap)
if [ -f /app/config/notification-html.sh ]; then
  . /app/config/notification-html.sh
else
  write_notification_html() { echo "❌ $4" >&2; }
fi
error_html() {  # <ddl|dcl> <title> <detail>
  write_notification_html "$R/$1" error "$2" "$3" "${DB_MIGRATE_PROJECT:-db-migrate}" \
    "${DB_MIGRATE_ENVIRONMENT:-?} | ${DB_MIGRATE_DB:-?} | ${1^^} | $(date -u +"%Y-%m-%d %H:%M") UTC"
}
# Run a db-migrate step, keeping a copy of its output so a failure email can
# quote the actual error. Sets STEP_RC.
run_step() {  # <log file> <command…>
  local log=$1; shift
  "$@" 2>&1 | tee "$log"
  STEP_RC=${PIPESTATUS[0]}
}
# The error line worth quoting from a step's output (ANSI colours stripped)
last_error() {
  sed 's/\x1b\[[0-9;]*m//g' "$1" 2>/dev/null | grep -E 'Last error:|\[ERROR\]|❌' | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-400
}
stopped_detail() {  # <exit code> <log file>
  local err; err=$(last_error "$2"); err=${err%.}
  echo "db-migrate stopped (exit $1) before writing its report${err:+: $err}. Full log: kubectl logs job/${DB_MIGRATE_JOB:-<job>}."
}

has_files() {  # ConfigMap mounts also hold ..data/..<timestamp> entries — skip dot names
  [ -n "$(find -L "$1" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -print -quit 2>/dev/null)" ]
}

# Read an args file: one argument per line, blank lines and # comments
# skipped, so values with spaces ("Alice (CAB-1042)") survive intact.
read_args() {
  local f=$1 line
  ARGS=()
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    case "$line" in
      -c|--config|-o|--output|-c=*|--config=*|-o=*|--output=*)
        ARGS_ERROR="$(basename "$f"): '$line' is set by run.sh and can't be overridden."
        echo "❌ $ARGS_ERROR" >&2
        return 1 ;;
    esac
    ARGS+=("$line")
  done < "$f"
}

# ── Inputs ───────────────────────────────────────────────────────
# Checked before anything runs: a broken DCL setup must not let DDL apply
# first and leave the deploy half done.
ddl_problem=""; dcl_problem=""
if [ ! -s /app/config/ddl.config.js ]; then
  ddl_problem="ddl.config.js is missing or empty in the run's config ConfigMap"
elif ! has_files /app/migrations/ddl; then
  ddl_problem="the DDL migrations ConfigMap is empty — no migration files to run"
fi
if [ -e /app/config/dcl.config.js ]; then
  if [ ! -s /app/config/dcl.config.js ]; then
    dcl_problem="dcl.config.js is empty in the run's config ConfigMap"
  elif ! has_files /app/migrations/dcl; then
    dcl_problem="the DCL scripts ConfigMap is empty — no R__ scripts to run"
  fi
fi

# ── DDL ──────────────────────────────────────────────────────────
ddl_status=failed
if [ -n "$ddl_problem" ] || [ -n "$dcl_problem" ]; then
  ddl_rc=1
  [ -n "$ddl_problem" ] && error_html ddl "Migration not started: invalid configuration" "$ddl_problem. Nothing was run."
  [ -n "$dcl_problem" ] && error_html dcl "Migration not started: invalid configuration" "$dcl_problem. Nothing was run (DDL included)."
  [ -z "$ddl_problem" ] && error_html ddl "Migration not started" "DDL was not run because the DCL configuration is invalid: $dcl_problem."
elif read_args /app/config/ddl.args; then
  echo "▶ DDL: sync ${ARGS[*]}"
  run_step /tmp/ddl.out "$EP" sync -c /app/config/ddl.config.js -o "$R/ddl" "${ARGS[@]}"
  ddl_rc=$STEP_RC
  # sync exits 1 both on failure and on "0 pending"; its JSON report tells
  # them apart. No report at all means it stopped before running anything.
  report=$(ls "$R"/ddl/sync-report-*.json 2>/dev/null | head -1)
  if [ -n "$report" ]; then
    ddl_status=$(node -p "require('$report').status")   # applied | no-pending | failed
  fi
  [ -e "$R/ddl/notification.html" ] || error_html ddl "DDL did not run" "$(stopped_detail "$ddl_rc" /tmp/ddl.out)"
else
  ddl_rc=1
  error_html ddl "Migration not started: invalid arguments" "$ARGS_ERROR Nothing was run."
fi

# ── DCL ──────────────────────────────────────────────────────────
dcl_status=not-run
dcl_rc=0
if [ ! -f /app/config/dcl.config.js ]; then
  dcl_status=not-configured
elif [ "$ddl_status" = applied ] || [ "$ddl_status" = no-pending ]; then
  if read_args /app/config/dcl.args; then
    echo "▶ DCL: dcl ${ARGS[*]}"
    run_step /tmp/dcl.out "$EP" dcl -c /app/config/dcl.config.js -o "$R/dcl" "${ARGS[@]}"
    dcl_rc=$STEP_RC
    [ $dcl_rc -eq 0 ] || [ -e "$R/dcl/notification.html" ] || error_html dcl "DCL did not run" "$(stopped_detail "$dcl_rc" /tmp/dcl.out)"
  else
    dcl_rc=1
    error_html dcl "DCL not started: invalid arguments" "$ARGS_ERROR DDL had already run — see the DDL email."
  fi
  # dcl writes an email only when something changed, failed or was skipped
  if [ $dcl_rc -ne 0 ]; then dcl_status=failed
  elif [ -e "$R/dcl/notification.html" ]; then dcl_status=changed
  else dcl_status=unchanged; fi
fi

[ -n "$dcl_problem" ] && { dcl_status=failed; dcl_rc=1; }

# ── Result ───────────────────────────────────────────────────────
if [ "$ddl_status" = failed ] || [ "$dcl_status" = failed ]; then
  rc=1
elif [ "$ddl_status" = no-pending ] && [ "$dcl_status" != changed ]; then
  rc=3
else
  rc=0
fi

DDL_STATUS=$ddl_status DDL_RC=$ddl_rc DCL_STATUS=$dcl_status DCL_RC=$dcl_rc RC=$rc node -e '
  const e = process.env;
  console.log(JSON.stringify({
    environment: e.DB_MIGRATE_ENVIRONMENT || null,
    ddl: { status: e.DDL_STATUS, rc: +e.DDL_RC },
    dcl: { status: e.DCL_STATUS, rc: +e.DCL_RC },
    rc: +e.RC
  }, null, 2));' > "$R/result.json"

(cd "$R" && find . -type f ! -name SHA256SUMS ! -name .ready ! -name .collected -exec sha256sum {} + > SHA256SUMS)
touch "$R/.ready"
echo "REPORTS_READY rc=$rc ddl=$ddl_status dcl=$dcl_status"

# ── Wait for the collector ───────────────────────────────────────
trap 'echo "terminated while waiting for collection" >&2; exit 143' TERM INT
timeout=${COLLECT_TIMEOUT_SECONDS:-3600}
deadline=$((SECONDS + timeout))
while [ ! -e "$R/.collected" ]; do
  if [ $SECONDS -ge $deadline ]; then
    echo "❌ Reports were not collected within ${timeout}s." >&2
    [ "$dcl_status" = changed ] && echo "   DCL changed accounts — any password generated in this run is now lost; rotate those accounts." >&2
    exit 4
  fi
  sleep 5 & wait $!
done
echo "✅ Reports collected — exiting with rc=$rc"
exit $rc
