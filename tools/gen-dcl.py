#!/usr/bin/env python3
"""
gen-dcl.py — Generate DCL Repeatable SQL migration files from accounts.yaml (v2)

Format: grants list supporting table-level privileges and alter resource limits.

Field reference:
  account:     MariaDB username (host defaults to '%')
  description: Group label — accounts with the same description share one SQL file
  host:        Connection source host (default '%')
  password:    Initial password (default CHANGE_ME_ON_FIRST_LOGIN)

  grants:      Grant list (required, at least one entry)
    - privileges: [SELECT, INSERT, ...]   # privilege list
      on: db.*                            # database-level
      on: db.table                        # table-level

  alter:       Resource limits (optional, no password fields)
    MAX_QUERIES_PER_HOUR:     N
    MAX_UPDATES_PER_HOUR:     N
    MAX_CONNECTIONS_PER_HOUR: N
    MAX_USER_CONNECTIONS:     N

  revoke:      Revoke list (optional, high-risk — written to a separate file)
    - privileges: [DROP, ALTER, ...]
      on: db.*  or db.table

  drop_user:   true = generate DROP USER IF EXISTS (default false)
  reset_pwd:   true = generate ALTER USER IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN' (default false)

Usage:
  python tools/gen-dcl.py databases/mariadb/dcl-scenario-test/accounts.yaml
  python tools/gen-dcl.py databases/mariadb/dcl-scenario-test/accounts.yaml --dry-run
  python tools/gen-dcl.py databases/mariadb/dcl-scenario-test/accounts.yaml -o /tmp/dcl-output
"""

import argparse
import re
import sys
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)


DEFAULT_PASSWORD = "CHANGE_ME_ON_FIRST_LOGIN"
DEFAULT_HOST = "%"

ALTER_RESOURCE_KEYS = frozenset({
    "MAX_QUERIES_PER_HOUR",
    "MAX_UPDATES_PER_HOUR",
    "MAX_CONNECTIONS_PER_HOUR",
    "MAX_USER_CONNECTIONS",
})

ON_PATTERN = re.compile(r"^[a-zA-Z0-9_]+\.(\*|[a-zA-Z0-9_]+)$")

VALID_PRIVILEGES = frozenset({
    "SELECT", "INSERT", "UPDATE", "DELETE",
    "CREATE", "ALTER", "DROP", "INDEX",
    "CREATE VIEW", "SHOW VIEW",
    "EXECUTE", "TRIGGER", "EVENT",
    "REFERENCES", "LOCK TABLES",
    "ALL", "ALL PRIVILEGES",
})


def get_on(item: dict) -> str:
    """
    PyYAML 1.1 treats unquoted 'on:' as boolean True.
    Support both {True: val} (unquoted on:) and {'on': val} (quoted "on":).
    """
    v = item.get("on") or item.get(True)
    return str(v) if v is not None else ""


def to_snake_case(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9\s]", "", text)
    text = re.sub(r"\s+", "_", text.strip())
    return text.lower()


def normalize_privileges(privs) -> str:
    if isinstance(privs, list):
        return ", ".join(p.strip().upper() for p in privs)
    return ", ".join(p.strip().upper() for p in str(privs).split(","))


def validate_account(acct: dict) -> list:
    errors = []
    name = acct.get("account", "<unknown>")

    if not acct.get("account"):
        errors.append("account: required")

    if not acct.get("description"):
        errors.append(f"{name}: description is required")

    grants = acct.get("grants")
    if not grants:
        errors.append(f"{name}: grants is required and must not be empty")
    else:
        for i, g in enumerate(grants):
            privs = g.get("privileges") or []
            if not privs:
                errors.append(f"{name}.grants[{i}]: privileges is required")
            else:
                for p in privs:
                    if str(p).strip().upper() not in VALID_PRIVILEGES:
                        errors.append(
                            f"{name}.grants[{i}]: unknown privilege '{p}'"
                            f" (allowed: {', '.join(sorted(VALID_PRIVILEGES))})"
                        )
            on = get_on(g)
            if not on:
                errors.append(f"{name}.grants[{i}]: on is required")
            elif not ON_PATTERN.match(on):
                errors.append(
                    f"{name}.grants[{i}]: on='{on}' invalid format"
                    f" — expected db.* or db.table"
                    f" (only letters, digits, underscore; max depth: table level)"
                )

    alter = acct.get("alter") or {}
    for k in alter:
        if k.upper() not in ALTER_RESOURCE_KEYS:
            errors.append(
                f"{name}.alter: unsupported key '{k}'"
                f" (allowed: {', '.join(sorted(ALTER_RESOURCE_KEYS))})"
            )

    revoke = acct.get("revoke")
    if revoke is not None:
        if isinstance(revoke, str):
            errors.append(
                f"{name}.revoke: string format is no longer supported, "
                f"use a list: [{{\"privileges\": [...], \"on\": \"db.*\"}}]"
            )
        elif isinstance(revoke, list):
            for i, r in enumerate(revoke):
                privs = r.get("privileges") or []
                if not privs:
                    errors.append(f"{name}.revoke[{i}]: privileges is required")
                else:
                    for p in privs:
                        if str(p).strip().upper() not in VALID_PRIVILEGES:
                            errors.append(
                                f"{name}.revoke[{i}]: unknown privilege '{p}'"
                                f" (allowed: {', '.join(sorted(VALID_PRIVILEGES))})"
                            )
                on = get_on(r)
                if not on:
                    errors.append(f"{name}.revoke[{i}]: on is required")
                elif not ON_PATTERN.match(on):
                    errors.append(
                        f"{name}.revoke[{i}]: on='{on}' invalid format"
                        f" — expected db.* or db.table"
                        f" (only letters, digits, underscore; max depth: table level)"
                    )

    return errors


def group_accounts(accounts: list) -> OrderedDict:
    groups = OrderedDict()
    for acct in accounts:
        desc = acct.get("description", "Unnamed")
        if desc not in groups:
            groups[desc] = []
        groups[desc].append(acct)
    return groups


def generate_revoke_block(revoke_list: list, user_spec: str) -> list:
    lines = []
    lines.append("USE mysql; -- temp procedure context")
    lines.append("DROP PROCEDURE IF EXISTS _ddl_revoke_tmp;")
    lines.append("DELIMITER //")
    lines.append("CREATE PROCEDURE _ddl_revoke_tmp()")
    lines.append("BEGIN")
    lines.append("  DECLARE CONTINUE HANDLER FOR 1141 BEGIN END;")
    for item in revoke_list:
        privs = normalize_privileges(item["privileges"])
        on_target = get_on(item)
        lines.append(f"  REVOKE {privs} ON {on_target} FROM {user_spec};")
    lines.append("END //")
    lines.append("DELIMITER ;")
    lines.append("CALL _ddl_revoke_tmp();")
    lines.append("DROP PROCEDURE IF EXISTS _ddl_revoke_tmp;")
    return lines


def generate_sql(description: str, accounts: list, seq: int) -> tuple:
    slug = to_snake_case(description)
    filename = f"R__{seq:02d}_{slug}.sql"

    lines = []
    lines.append(f"-- {filename}")
    lines.append(f"-- DCL Repeatable Migration: {description}")
    lines.append("--")
    lines.append("-- Idempotent: CREATE USER IF NOT EXISTS")
    lines.append("-- Re-executed when checksum changes")
    lines.append("")

    for acct in accounts:
        account  = acct["account"]
        host     = acct.get("host", DEFAULT_HOST)
        password = acct.get("password", DEFAULT_PASSWORD)
        grants   = acct.get("grants", [])
        alter    = acct.get("alter") or {}

        user_spec = f"'{account}'@'{host}'"

        lines.append("-- ============================================")
        lines.append(f"-- {account}")
        lines.append("-- ============================================")
        lines.append("")

        lines.append(f"CREATE USER IF NOT EXISTS {user_spec} IDENTIFIED BY '{password}';")
        lines.append("")

        for g in grants:
            privs     = normalize_privileges(g["privileges"])
            on_target = get_on(g)
            lines.append(f"GRANT {privs} ON {on_target} TO {user_spec};")
        lines.append("")

        if alter:
            parts = " ".join(f"{k.upper()} {v}" for k, v in alter.items())
            lines.append(f"ALTER USER {user_spec} WITH {parts};")
            lines.append("")

    lines.append("-- Apply changes")
    lines.append("FLUSH PRIVILEGES;")
    lines.append("")

    return filename, "\n".join(lines)


def generate_dangerous_files(accounts: list, timestamp: str) -> list:
    results = []

    for acct in accounts:
        account   = acct["account"]
        host      = acct.get("host", DEFAULT_HOST)
        drop_user = acct.get("drop_user", False)
        revoke    = acct.get("revoke") or []
        reset_pwd = acct.get("reset_pwd", False)

        user_spec = f"'{account}'@'{host}'"
        acc_slug  = account.replace("-", "_").lower()

        if drop_user:
            filename = f"R__{timestamp}_drop_user_{acc_slug}.sql"
            lines = [
                "-- @allow-forbidden: true",
                f"-- {filename}",
                f"-- DCL High-Risk: DROP USER — {account}",
                "-- ⚠️  DROP USER is irreversible — approved via @allow-forbidden",
                "",
                "-- ============================================",
                f"-- Drop: {account}",
                "-- ============================================",
                "",
                f"DROP USER IF EXISTS {user_spec};",
                "",
                "-- Apply changes",
                "FLUSH PRIVILEGES;",
                "",
            ]
            results.append((filename, "\n".join(lines)))

        if revoke:
            revoke_summary = "; ".join(
                f"{normalize_privileges(r['privileges'])} ON {get_on(r)}" for r in revoke
            )
            filename = f"R__{timestamp}_revoke_{acc_slug}.sql"
            lines = [
                "-- @allow-forbidden: true",
                f"-- {filename}",
                f"-- DCL High-Risk: REVOKE — {account}",
                "-- ⚠️  Contains REVOKE statements — approved via @allow-forbidden",
                "-- ⚠️  Uses CONTINUE HANDLER FOR 1141 for MariaDB 10.6 idempotency",
                "",
                "-- ============================================",
                f"-- Revoke: {account} ({revoke_summary})",
                "-- ============================================",
                "",
            ]
            lines.extend(generate_revoke_block(revoke, user_spec))
            lines.extend([
                "",
                "-- Apply changes",
                "FLUSH PRIVILEGES;",
                "",
            ])
            results.append((filename, "\n".join(lines)))

        if reset_pwd:
            filename = f"R__{timestamp}_reset_pwd_{acc_slug}.sql"
            lines = [
                "-- @allow-forbidden: true",
                f"-- {filename}",
                f"-- DCL High-Risk: RESET PASSWORD — {account}",
                "-- ⚠️  ALTER USER changes credentials — approved via @allow-forbidden",
                "",
                "-- ============================================",
                f"-- Reset password: {account}",
                "-- ============================================",
                "",
                f"ALTER USER {user_spec} IDENTIFIED BY '{DEFAULT_PASSWORD}';",
                "",
                "-- Apply changes",
                "FLUSH PRIVILEGES;",
                "",
            ]
            results.append((filename, "\n".join(lines)))

    return results


def main():
    parser = argparse.ArgumentParser(
        description="Generate DCL SQL files from accounts.yaml (v2 format)"
    )
    parser.add_argument("config", help="Path to accounts.yaml")
    parser.add_argument(
        "-o", "--output-dir", default=None,
        help="Output directory (default: <config_dir>/migrations/)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print generated SQL to stdout without writing files"
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.exists():
        print(f"ERROR: Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    accounts = config.get("accounts", [])
    if not accounts:
        print("WARNING: No accounts defined in config", file=sys.stderr)
        sys.exit(0)

    all_errors = []
    for acct in accounts:
        all_errors.extend(validate_account(acct))

    # account names must be unique
    seen, duplicates = set(), set()
    for acct in accounts:
        name = acct.get("account", "")
        if name in seen:
            duplicates.add(name)
        seen.add(name)
    for dup in sorted(duplicates):
        all_errors.append(f"account '{dup}': duplicate account name — each account must appear only once")

    if all_errors:
        print("ERROR: accounts.yaml validation failed:", file=sys.stderr)
        for e in all_errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    groups    = group_accounts(accounts)
    timestamp = datetime.today().strftime("%Y%m%d")

    output_dir = (
        Path(args.output_dir) if args.output_dir
        else config_path.parent / "migrations"
    )

    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    generated_main      = []
    generated_dangerous = []

    for seq, (description, group_accts) in enumerate(groups.items(), start=1):
        filename, sql = generate_sql(description, group_accts, seq)
        generated_main.append(filename)

        if args.dry_run:
            print("=" * 60)
            print(f"FILE: {filename}")
            print("=" * 60)
            print(sql)
        else:
            out_path = output_dir / filename
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(sql)
            print(f"✅ Generated: {out_path}")

    dangerous_files = generate_dangerous_files(accounts, timestamp)
    for filename, sql in dangerous_files:
        generated_dangerous.append(filename)

        if args.dry_run:
            print("=" * 60)
            print(f"FILE: {filename}  ⚠️  HIGH-RISK (@allow-forbidden)")
            print("=" * 60)
            print(sql)
        else:
            out_path = output_dir / filename
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(sql)
            print(f"⚠️  Generated (high-risk): {out_path}")

    if not args.dry_run:
        print(f"\n📁 Output directory: {output_dir}")
        print(f"📝 Main files ({len(generated_main)}): {', '.join(generated_main)}")
        if generated_dangerous:
            print(
                f"⚠️  High-risk files ({len(generated_dangerous)}): "
                f"{', '.join(generated_dangerous)}"
            )


if __name__ == "__main__":
    main()
