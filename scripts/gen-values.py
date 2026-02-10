#!/usr/bin/env python3
"""
gen-values.py — 從專案目錄自動產生 Helm values.yaml

掃描 <project_dir>/ddl/*/migrations/ 和 <project_dir>/dcl/migrations/
讀取 SQL/JS 檔案，解析 config.js 中的連線資訊，產生 values.yaml。

使用方式:
  python scripts/gen-values.py databases/mariadb/production-server
  python scripts/gen-values.py databases/mariadb/production-server -o charts/db-migrate/values-production.yaml
  python scripts/gen-values.py databases/mariadb/production-server --host mariadb.prod.svc.cluster.local

範例輸出:
  migrations:
    enabled: true
    databases:
      - name: ecommerce
        type: mariadb
        host: mariadb.production.svc.cluster.local
        port: 3306
        ddl:
          existingSecret: ecommerce-ddl-secret
          sanityCheck: { enabled: true, autoRollback: true, timeoutMs: 30000 }
          files:
            20260101000001-create-users.sql: |
              CREATE TABLE IF NOT EXISTS users ( ... );
        dcl:
          user: root
          existingSecret: dcl-root-secret
          files:
            R__01_readonly_users.sql: |
              CREATE USER IF NOT EXISTS ...
"""

import argparse
import os
import re
import sys
from pathlib import Path


def parse_config_js(config_path: Path) -> dict:
    """
    從 config.js 解析連線資訊 (best-effort regex parsing)。
    支援 nested (mariadb.host) 和 flat (host) 兩種格式。
    """
    info = {}
    if not config_path.exists():
        return info

    content = config_path.read_text(encoding="utf-8")

    # 嘗試解析 type
    m = re.search(r"type:\s*['\"](\w+)['\"]", content)
    if m:
        info["type"] = m.group(1)

    # 嘗試解析 database (nested or flat)
    m = re.search(r"database:\s*(?:process\.env\.\w+\s*\|\|\s*)?['\"]([^'\"]+)['\"]", content)
    if m:
        info["database"] = m.group(1)

    # 嘗試解析 host
    m = re.search(r"host:\s*(?:process\.env\.\w+\s*\|\|\s*)?['\"]([^'\"]+)['\"]", content)
    if m:
        info["host"] = m.group(1)

    # 嘗試解析 port
    m = re.search(r"port:\s*(?:parseInt\([^)]*\)\s*\|\|\s*)?(\d+)", content)
    if m:
        info["port"] = int(m.group(1))
    else:
        m = re.search(r"['\"](\d+)['\"]", content)

    # 嘗試解析 user
    m = re.search(r"user:\s*(?:process\.env\.\w+\s*\|\|\s*)?['\"]([^'\"]+)['\"]", content)
    if m:
        info["user"] = m.group(1)

    # 嘗試解析 checksumTable
    m = re.search(r"checksumTable:\s*['\"]([^'\"]+)['\"]", content)
    if m:
        info["checksumTable"] = m.group(1)

    # 嘗試解析 changelogTable
    m = re.search(r"changelogTable:\s*['\"]([^'\"]+)['\"]", content)
    if m:
        info["changelogTable"] = m.group(1)

    # 嘗試解析 sanityCheck
    if "sanityCheck" in content:
        sc = {}
        m = re.search(r"enabled:\s*(true|false)", content[content.index("sanityCheck"):])
        if m:
            sc["enabled"] = m.group(1) == "true"
        m = re.search(r"autoRollback:\s*(true|false)", content[content.index("sanityCheck"):])
        if m:
            sc["autoRollback"] = m.group(1) == "true"
        m = re.search(r"timeoutMs:\s*(\d+)", content[content.index("sanityCheck"):])
        if m:
            sc["timeoutMs"] = int(m.group(1))
        if sc:
            info["sanityCheck"] = sc

    return info


def scan_ddl_databases(project_dir: Path) -> list[dict]:
    """掃描 <project_dir>/ddl/*/ 中各 database 的 DDL 遷移檔案。"""
    ddl_dir = project_dir / "ddl"
    databases = []

    if not ddl_dir.is_dir():
        return databases

    for db_dir in sorted(ddl_dir.iterdir()):
        if not db_dir.is_dir():
            continue

        migrations_dir = db_dir / "migrations"
        config_path = db_dir / "config.js"

        config_info = parse_config_js(config_path)
        db_name = config_info.get("database", db_dir.name)

        # 收集 migration 檔案
        files = {}
        if migrations_dir.is_dir():
            for f in sorted(migrations_dir.iterdir()):
                if f.is_file() and f.suffix in (".sql", ".js"):
                    files[f.name] = f.read_text(encoding="utf-8")

        if files:
            databases.append({
                "name": db_name,
                "dir_name": db_dir.name,
                "type": config_info.get("type", "mariadb"),
                "config": config_info,
                "files": files,
            })

    return databases


def scan_dcl_migrations(project_dir: Path) -> dict:
    """掃描 <project_dir>/dcl/migrations/ 中的 DCL 遷移檔案。"""
    dcl_dir = project_dir / "dcl"
    migrations_dir = dcl_dir / "migrations"
    config_path = dcl_dir / "config.js"

    result = {"config": parse_config_js(config_path), "files": {}}

    if migrations_dir.is_dir():
        for f in sorted(migrations_dir.iterdir()):
            if f.is_file() and f.suffix in (".sql", ".js"):
                result["files"][f.name] = f.read_text(encoding="utf-8")

    return result


def yaml_quote(s: str) -> str:
    """如果字串包含特殊字元，用引號包裹。"""
    if any(c in s for c in ":{}&*?|>!%@`"):
        return f'"{s}"'
    return s


def indent_content(content: str, spaces: int) -> str:
    """將多行內容縮排指定空格數。"""
    prefix = " " * spaces
    lines = content.rstrip("\n").split("\n")
    return "\n".join(prefix + line if line.strip() else "" for line in lines)


def generate_values_yaml(
    databases: list[dict],
    dcl_info: dict,
    *,
    host_override: str | None = None,
    port_override: int | None = None,
    image_tag: str | None = None,
) -> str:
    """產生 values.yaml 內容。"""
    lines = []
    lines.append("# ============================================================")
    lines.append("# Auto-generated by gen-values.py")
    lines.append(f"# Source: {len(databases)} database(s)")
    lines.append("# ============================================================")
    lines.append("")

    # Image tag
    if image_tag:
        lines.append("image:")
        lines.append(f"  tag: \"{image_tag}\"")
        lines.append("")

    # Disable single-DB modes
    lines.append("# 關閉舊的單一 DB 模式")
    lines.append("mongodb:")
    lines.append("  enabled: false")
    lines.append("mariadb:")
    lines.append("  enabled: false")
    lines.append("")

    # Disable old job mode
    lines.append("# 關閉舊的單一 Job（改用 migrations.databases 產生的 Jobs）")
    lines.append("job:")
    lines.append("  enabled: false")
    lines.append("  backoffLimit: 3")
    lines.append("  ttlSecondsAfterFinished: 600")
    lines.append("  activeDeadlineSeconds: 300")
    lines.append("  restartPolicy: Never")
    lines.append("")

    # Multi-database migrations
    lines.append("# ============================================================")
    lines.append("# 多資料庫遷移設定")
    lines.append("# ============================================================")
    lines.append("migrations:")
    lines.append("  enabled: true")
    lines.append("")
    lines.append("  databases:")

    dcl_files = dcl_info.get("files", {})
    dcl_config = dcl_info.get("config", {})

    for db in databases:
        db_name = db["name"]
        db_type = db["type"]
        cfg = db["config"]
        host = host_override or cfg.get("host", "localhost")
        port = port_override or cfg.get("port", 3306)

        lines.append(f"    # {'─' * 52}")
        lines.append(f"    # Database: {db_name}")
        lines.append(f"    # {'─' * 52}")
        lines.append(f"    - name: {db_name}")
        lines.append(f"      type: {db_type}")
        lines.append(f"      host: {host}")
        lines.append(f"      port: {port}")
        lines.append("")

        # DDL section
        lines.append("      ddl:")
        lines.append(f"        user: {db_name}_ddl_admin")
        lines.append(f"        existingSecret: {db_name}-ddl-secret")
        lines.append("        secretKey: mariadb-password")

        sc = cfg.get("sanityCheck", {"enabled": True, "autoRollback": True, "timeoutMs": 30000})
        lines.append("        sanityCheck:")
        lines.append(f"          enabled: {str(sc.get('enabled', True)).lower()}")
        lines.append(f"          autoRollback: {str(sc.get('autoRollback', True)).lower()}")
        lines.append(f"          timeoutMs: {sc.get('timeoutMs', 30000)}")

        lines.append("        files:")
        for fname, content in db["files"].items():
            lines.append(f"          {fname}: |")
            lines.append(indent_content(content, 12))
            lines.append("")

        # DCL section — attach shared DCL files filtered by db name, or all if only 1 DB
        # Strategy: include all DCL files that mention this db_name, or all if no filtering possible
        db_dcl_files = {}
        for fname, content in dcl_files.items():
            # Check if file references this specific database
            if db_name in fname.lower() or db_name in content.lower():
                db_dcl_files[fname] = content

        # If no db-specific DCL found and this is the first DB, attach all DCL files
        if not db_dcl_files and databases.index(db) == 0 and dcl_files:
            db_dcl_files = dcl_files

        if db_dcl_files:
            lines.append("      dcl:")
            dcl_user = dcl_config.get("user", "root")
            lines.append(f"        user: {dcl_user}")
            lines.append("        existingSecret: dcl-root-secret")
            lines.append("        secretKey: mariadb-password")
            lines.append("        files:")
            for fname, content in db_dcl_files.items():
                lines.append(f"          {fname}: |")
                lines.append(indent_content(content, 12))
                lines.append("")

        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="從專案目錄產生 Helm values.yaml (多資料庫 ConfigMap 模式)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
範例:
  %(prog)s databases/mariadb/production-server
  %(prog)s databases/mariadb/production-server -o values-prod.yaml
  %(prog)s databases/mariadb/production-server --host mariadb.prod.svc.cluster.local --port 3306
        """,
    )
    parser.add_argument(
        "project_dir",
        help="專案目錄路徑，例如 databases/mariadb/production-server",
    )
    parser.add_argument(
        "-o", "--output",
        help="輸出 values.yaml 路徑 (預設: stdout)",
    )
    parser.add_argument(
        "--host",
        help="覆蓋所有資料庫的 host 設定",
    )
    parser.add_argument(
        "--port",
        type=int,
        help="覆蓋所有資料庫的 port 設定",
    )
    parser.add_argument(
        "--image-tag",
        help="設定 image.tag",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="僅顯示掃描結果，不產生 YAML",
    )

    args = parser.parse_args()
    project_dir = Path(args.project_dir)

    if not project_dir.is_dir():
        print(f"❌ 目錄不存在: {project_dir}", file=sys.stderr)
        sys.exit(1)

    # Scan DDL databases
    ddl_databases = scan_ddl_databases(project_dir)
    # Scan DCL migrations
    dcl_info = scan_dcl_migrations(project_dir)

    if not ddl_databases and not dcl_info["files"]:
        print(f"⚠️  未找到任何遷移檔案: {project_dir}", file=sys.stderr)
        print(f"   預期結構:", file=sys.stderr)
        print(f"   {project_dir}/ddl/<db-name>/migrations/*.sql", file=sys.stderr)
        print(f"   {project_dir}/dcl/migrations/*.sql", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print(f"📂 專案目錄: {project_dir}")
        print(f"\n🔧 DDL Databases ({len(ddl_databases)}):")
        for db in ddl_databases:
            print(f"  - {db['name']} ({len(db['files'])} files)")
            for f in db["files"]:
                print(f"    • {f}")
        print(f"\n🔐 DCL Migrations ({len(dcl_info['files'])} files):")
        for f in dcl_info["files"]:
            print(f"    • {f}")
        return

    # Generate YAML
    yaml_content = generate_values_yaml(
        ddl_databases,
        dcl_info,
        host_override=args.host,
        port_override=args.port,
        image_tag=args.image_tag,
    )

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(yaml_content, encoding="utf-8")
        print(f"✅ 已產生: {output_path}", file=sys.stderr)
        print(f"   - {len(ddl_databases)} DDL database(s)", file=sys.stderr)
        print(f"   - {len(dcl_info['files'])} DCL file(s)", file=sys.stderr)
    else:
        print(yaml_content)


if __name__ == "__main__":
    main()
