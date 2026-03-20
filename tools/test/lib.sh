#!/usr/bin/env bash
# lib.sh — 共用測試函式庫
#
# 支援兩種使用方式:
#   1. 單獨執行 scenario_XX.sh (自建 counter/buffer)
#   2. 由 run_all.sh 統一管理 (透過 export COUNTER_FILE / REPORT_BUFFER_FILE 共享)

# ── 顏色 ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── 設定 ─────────────────────────────────────────────────────────
export MARIADB_HOST="${MARIADB_HOST:-127.0.0.1}"
export MARIADB_PORT="${MARIADB_PORT:-3307}"
export MARIADB_ROOT_PASS="${MARIADB_ROOT_PASS:-root}"
export CONTAINER_NAME="${CONTAINER_NAME:-mariadb-dcl-test}"
export PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export DCL_OUT="${DCL_OUT:-/tmp/dcl-test-out}"
export REPORT_FILE="${REPORT_FILE:-${PROJECT_ROOT}/tools/test/report.md}"

# ── Counter file (共享或私有) ─────────────────────────────────────
# 若 run_all.sh 已 export COUNTER_FILE，直接複用；否則自建
if [[ -z "${COUNTER_FILE:-}" ]]; then
  export COUNTER_FILE="/tmp/dcl_counters_$$"
  echo "PASS=0 FAIL=0" > "$COUNTER_FILE"
fi

# ── Report buffer file (共享或私有) ──────────────────────────────
if [[ -z "${REPORT_BUFFER_FILE:-}" ]]; then
  export REPORT_BUFFER_FILE="/tmp/dcl_report_buffer_$$"
  > "$REPORT_BUFFER_FILE"
fi

# ── Counter helpers ───────────────────────────────────────────────
_inc() {
  local key=$1
  local val
  val=$(grep -oP "(?<=${key}=)\d+" "$COUNTER_FILE")
  val=$(( val + 1 ))
  sed -i "s/${key}=[0-9]*/${key}=${val}/" "$COUNTER_FILE"
}
_get() { grep -oP "(?<=${1}=)\d+" "$COUNTER_FILE"; }

# ── Report helpers ────────────────────────────────────────────────
_report() { echo "$1" >> "$REPORT_BUFFER_FILE"; }

report_table_header() {
  _report "| 結果 | 帳號 | 說明 | 備註 |"
  _report "|------|------|------|------|"
}

# ── 輸出 helpers ──────────────────────────────────────────────────
section() {
  echo ""
  echo -e "${CYAN}${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${CYAN}${BOLD}  $1${RESET}"
  echo -e "${CYAN}${BOLD}════════════════════════════════════════${RESET}"
  _report ""
  _report "### $1"
  _report ""
}

step() { echo -e "${YELLOW}▶ $1${RESET}"; }

# ── MySQL 連線 helpers ────────────────────────────────────────────
mysql_root() {
  docker exec "${CONTAINER_NAME}" mysql -h127.0.0.1 \
    -uroot -p"${MARIADB_ROOT_PASS}" \
    --silent --skip-column-names 2>/dev/null \
    -e "$1"
}

mysql_as() {
  docker exec "${CONTAINER_NAME}" mysql -h127.0.0.1 \
    -u"$1" -p"$2" "$3" \
    --silent --skip-column-names 2>&1 \
    -e "$4"
}

# ── Assert 函式 ───────────────────────────────────────────────────

# assert_succeeds <description> <user> <pass> <db> <sql>
assert_succeeds() {
  local desc=$1 user=$2 pass=$3 db=$4 sql=$5
  local out
  out=$(mysql_as "$user" "$pass" "$db" "$sql" 2>&1) || true
  if echo "$out" | grep -qi "ERROR"; then
    echo -e "  ${RED}✗ FAIL${RESET} $desc"
    echo -e "       got: $out"
    _inc FAIL
    _report "| ✗ FAIL | \`$user\` | $desc | \`$out\` |"
  else
    echo -e "  ${GREEN}✓ PASS${RESET} $desc"
    _inc PASS
    _report "| ✓ PASS | \`$user\` | $desc | — |"
  fi
}

# assert_fails <description> <expected_error_code> <user> <pass> <db> <sql>
assert_fails() {
  local desc=$1 expected_code=$2 user=$3 pass=$4 db=$5 sql=$6
  local out
  out=$(mysql_as "$user" "$pass" "$db" "$sql" 2>&1) || true
  if echo "$out" | grep -q "ERROR ${expected_code}"; then
    echo -e "  ${GREEN}✓ PASS${RESET} $desc (ERROR ${expected_code} 符合預期)"
    _inc PASS
    _report "| ✓ PASS | \`$user\` | $desc | ERROR ${expected_code} ✓ |"
  else
    echo -e "  ${RED}✗ FAIL${RESET} $desc (預期 ERROR ${expected_code})"
    echo -e "       got: $out"
    _inc FAIL
    _report "| ✗ FAIL | \`$user\` | $desc | 預期 ERROR ${expected_code}，got: \`$out\` |"
  fi
}

# assert_user_exists <user>
assert_user_exists() {
  local user=$1
  local cnt
  cnt=$(mysql_root "SELECT COUNT(*) FROM mysql.user WHERE User='${user}' AND Host='%';") || true
  if [[ "${cnt:-0}" -ge 1 ]]; then
    echo -e "  ${GREEN}✓ PASS${RESET} 帳號 \`$user\` 存在"
    _inc PASS
    _report "| ✓ PASS | — | 帳號 \`$user\` 存在 | — |"
  else
    echo -e "  ${RED}✗ FAIL${RESET} 帳號 \`$user\` 不存在 (預期存在)"
    _inc FAIL
    _report "| ✗ FAIL | — | 帳號 \`$user\` 存在 | 查無此帳號 |"
  fi
}

# assert_user_not_exists <user>
assert_user_not_exists() {
  local user=$1
  local cnt
  cnt=$(mysql_root "SELECT COUNT(*) FROM mysql.user WHERE User='${user}' AND Host='%';") || true
  if [[ "${cnt:-1}" -eq 0 ]]; then
    echo -e "  ${GREEN}✓ PASS${RESET} 帳號 \`$user\` 已不存在"
    _inc PASS
    _report "| ✓ PASS | — | 帳號 \`$user\` 已不存在 | — |"
  else
    echo -e "  ${RED}✗ FAIL${RESET} 帳號 \`$user\` 仍存在 (預期已刪除)"
    _inc FAIL
    _report "| ✗ FAIL | — | 帳號 \`$user\` 已不存在 | 帳號仍存在 |"
  fi
}

# assert_idempotent <description> <dcl_file>
assert_idempotent() {
  local desc=$1 file=$2
  local out
  out=$(docker exec -i "${CONTAINER_NAME}" mysql \
    -uroot -p"${MARIADB_ROOT_PASS}" 2>&1 < "$file") || true
  if echo "$out" | grep -qP "ERROR [1-9]"; then
    echo -e "  ${RED}✗ FAIL${RESET} 冪等: $desc"
    echo -e "       got: $out"
    _inc FAIL
    _report "| ✗ FAIL | — | 冪等: $desc | \`$out\` |"
  else
    echo -e "  ${GREEN}✓ PASS${RESET} 冪等: $desc"
    _inc PASS
    _report "| ✓ PASS | — | 冪等: $desc | 重跑無報錯 |"
  fi
}

# assert_resource_limit <description> <user> <alter_key> <expected_value>
# alter_key: MAX_QUERIES_PER_HOUR | MAX_UPDATES_PER_HOUR |
#            MAX_CONNECTIONS_PER_HOUR | MAX_USER_CONNECTIONS
assert_resource_limit() {
  local desc=$1 user=$2 alter_key=$3 expected=$4
  local column
  case "$alter_key" in
    MAX_QUERIES_PER_HOUR)     column="max_questions" ;;
    MAX_UPDATES_PER_HOUR)     column="max_updates" ;;
    MAX_CONNECTIONS_PER_HOUR) column="max_connections" ;;
    MAX_USER_CONNECTIONS)     column="max_user_connections" ;;
    *) echo -e "  ${RED}✗ FAIL${RESET} unknown alter_key: $alter_key"; _inc FAIL; return ;;
  esac
  local actual
  actual=$(mysql_root "SELECT ${column} FROM mysql.user WHERE User='${user}' AND Host='%';") || true
  if [[ "${actual}" == "${expected}" ]]; then
    echo -e "  ${GREEN}✓ PASS${RESET} $desc (${alter_key}=${expected})"
    _inc PASS
    _report "| ✓ PASS | \`$user\` | $desc | ${alter_key}=${expected} |"
  else
    echo -e "  ${RED}✗ FAIL${RESET} $desc (預期 ${alter_key}=${expected}，got=${actual})"
    _inc FAIL
    _report "| ✗ FAIL | \`$user\` | $desc | 預期 ${alter_key}=${expected}，got=${actual} |"
  fi
}

# ── DCL helpers ───────────────────────────────────────────────────

# gen_dcl <fixture_yaml>
gen_dcl() {
  local fixture=$1
  step "gen-dcl.py ← $(basename "$fixture")"
  mkdir -p "${PROJECT_ROOT}/databases/mariadb/dcl-scenario-test"
  cp "$fixture" "${PROJECT_ROOT}/databases/mariadb/dcl-scenario-test/accounts.yaml"
  mkdir -p "$DCL_OUT"
  python3 "${PROJECT_ROOT}/tools/gen-dcl.py" \
    "${PROJECT_ROOT}/databases/mariadb/dcl-scenario-test/accounts.yaml" \
    -o "$DCL_OUT"
}

# apply_dcl <file>
apply_dcl() {
  local file=$1
  step "apply: $(basename "$file")"
  docker exec -i "${CONTAINER_NAME}" mysql \
    -uroot -p"${MARIADB_ROOT_PASS}" 2>/dev/null < "$file" || true
}

# ── 最終 Report 輸出 ──────────────────────────────────────────────
write_report() {
  local pass fail
  pass=$(_get PASS); fail=$(_get FAIL)
  local total=$(( pass + fail ))
  local status_icon="✅"
  [[ $fail -gt 0 ]] && status_icon="❌"

  {
    echo "# DCL Migration Test Report"
    echo ""
    echo "> Generated: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "> MariaDB: 10.6 | Project: ddl-migrate | gen-dcl.py"
    echo ""
    echo "## Summary"
    echo ""
    echo "| | Count |"
    echo "|---|---|"
    echo "| ${status_icon} Total | ${total} |"
    echo "| ✓ PASS | ${pass} |"
    echo "| ✗ FAIL | ${fail} |"
    echo ""
    echo "## 帳號生命週期情境"
    echo ""
    cat "$REPORT_BUFFER_FILE"
  } > "$REPORT_FILE"

  echo ""
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  Test Summary${RESET}"
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "  Total : ${total}"
  echo -e "  ${GREEN}PASS  : ${pass}${RESET}"
  if [[ $fail -gt 0 ]]; then
    echo -e "  ${RED}FAIL  : ${fail}${RESET}"
  else
    echo -e "  FAIL  : ${fail}"
  fi
  echo ""
  echo -e "  Report: ${CYAN}${REPORT_FILE}${RESET}"
  echo ""

  rm -f "$COUNTER_FILE" "$REPORT_BUFFER_FILE"
  [[ $fail -eq 0 ]]
}
