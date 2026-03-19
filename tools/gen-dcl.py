#!/usr/bin/env python3
"""
gen-dcl.py — 從 accounts.yaml 產生 DCL Repeatable SQL migration 檔案

accounts.yaml 格式: 扁平 accounts 列表，用 description 自動分組產生檔案。
檔名規則: 依 description 出現順序，R__01_<snake_case>.sql

使用方式:
  python tools/gen-dcl.py databases/mariadb/production-server/dcl/accounts.yaml
  python tools/gen-dcl.py databases/mariadb/production-server/dcl/accounts.yaml --dry-run
  python tools/gen-dcl.py databases/mariadb/production-server/dcl/accounts.yaml -o /tmp/dcl-output

欄位說明:
  account:     帳號名稱 (自動加 @'%')
  databases:   授權的資料庫列表
  grant:       授予的權限 (逗號分隔)
  description: 分組名稱 (相同 description 產生同一個 SQL 檔)
  revoke:      撤銷的權限 (選填，自動加 @allow-forbidden annotation)
  reset_pwd:   true = 產生 ALTER USER PASSWORD EXPIRE (選填)
  host:        連線來源 (預設 '%')
  password:    密碼 (預設 CHANGE_ME_ON_FIRST_LOGIN)
  comment:     額外說明 (選填)
"""

import argparse
import re
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed. Run: pip install pyyaml", file=sys.stderr)
    sys.exit(1)


DEFAULT_PASSWORD = "CHANGE_ME_ON_FIRST_LOGIN"
DEFAULT_HOST = "%"


def to_snake_case(text: str) -> str:
    """Convert description to snake_case filename part."""
    text = re.sub(r"[^a-zA-Z0-9\s]", "", text)
    text = re.sub(r"\s+", "_", text.strip())
    return text.lower()


def normalize_grants(grant_str: str) -> str:
    """正規化權限字串: 去空白、大寫"""
    return ", ".join(g.strip().upper() for g in grant_str.split(","))


def group_accounts(accounts: list) -> OrderedDict:
    """依 description 分組，保持出現順序"""
    groups = OrderedDict()
    for acct in accounts:
        desc = acct.get("description", "Unnamed")
        if desc not in groups:
            groups[desc] = []
        groups[desc].append(acct)
    return groups


def generate_sql(description: str, accounts: list, seq: int) -> tuple:
    """產生單一 SQL 檔案內容，回傳 (filename, sql)"""
    slug = to_snake_case(description)
    filename = f"R__{seq:02d}_{slug}.sql"

    needs_allow_forbidden = any(a.get("revoke") for a in accounts)

    lines = []

    # Header
    if needs_allow_forbidden:
        lines.append("-- @allow-forbidden: true")
    lines.append(f"-- {filename}")
    lines.append(f"-- DCL Repeatable Migration: {description}")
    lines.append("--")
    lines.append("-- This script is idempotent - uses CREATE USER IF NOT EXISTS")
    lines.append("-- Will be re-executed when checksum changes")
    if needs_allow_forbidden:
        lines.append("-- ⚠️ Contains REVOKE statements — approved via @allow-forbidden")
    lines.append("")

    for acct in accounts:
        account = acct["account"]
        host = acct.get("host", DEFAULT_HOST)
        password = acct.get("password", DEFAULT_PASSWORD)
        databases = acct.get("databases", [])
        grant = acct.get("grant", "")
        revoke = acct.get("revoke", "")
        reset_pwd = acct.get("reset_pwd", False)
        comment = acct.get("comment", "")

        user_spec = f"'{account}'@'{host}'"
        db_label = ", ".join(databases) if databases else "N/A"

        # Section header
        lines.append("-- ============================================")
        lines.append(f"-- {account} ({db_label})")
        if comment:
            lines.append(f"-- {comment}")
        lines.append("-- ============================================")
        lines.append("")

        # CREATE USER
        lines.append(f"CREATE USER IF NOT EXISTS {user_spec} IDENTIFIED BY '{password}';")
        lines.append("")

        # REVOKE (before GRANT — clean slate)
        if revoke:
            revoke_normalized = normalize_grants(revoke)
            for db in databases:
                lines.append(f"REVOKE {revoke_normalized} ON {db}.* FROM {user_spec};")
            lines.append("")

        # GRANT
        if grant:
            grant_normalized = normalize_grants(grant)
            for db in databases:
                lines.append(f"GRANT {grant_normalized} ON {db}.* TO {user_spec};")
            lines.append("")

        # RESET PASSWORD
        if reset_pwd:
            lines.append(f"ALTER USER {user_spec} PASSWORD EXPIRE;")
            lines.append("")

    # FLUSH PRIVILEGES
    lines.append("-- Apply changes")
    lines.append("FLUSH PRIVILEGES;")
    lines.append("")

    return filename, "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Generate DCL SQL files from accounts.yaml"
    )
    parser.add_argument("config", help="Path to accounts.yaml")
    parser.add_argument("-o", "--output-dir", default=None,
                        help="Output directory (default: <config_dir>/migrations/)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print generated SQL to stdout without writing files")
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

    groups = group_accounts(accounts)

    # Output directory
    output_dir = Path(args.output_dir) if args.output_dir else config_path.parent / "migrations"

    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    generated = []
    for seq, (description, group_accounts_list) in enumerate(groups.items(), start=1):
        filename, sql = generate_sql(description, group_accounts_list, seq)
        generated.append(filename)

        if args.dry_run:
            print(f"{'=' * 60}")
            print(f"FILE: {filename}")
            print(f"{'=' * 60}")
            print(sql)
        else:
            out_path = output_dir / filename
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(sql)
            print(f"✅ Generated: {out_path}")

    if not args.dry_run:
        print(f"\n📁 Output directory: {output_dir}")
        print(f"📝 Generated {len(generated)} file(s): {', '.join(generated)}")


if __name__ == "__main__":
    main()
