# DB-Migrate v2.1

> 統一的多資料庫遷移管理工具，支援 MongoDB 與 MariaDB/MySQL，包含多實例同步測試、DDL 版本化遷移與 DCL Repeatable 模式

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](package.json)

## 🎯 特點

- **多資料庫支援**: MongoDB (via migrate-mongo) 和 MariaDB/MySQL (sql-migrate 模式)
- **多實例支援**: 同時管理多個資料庫實例 (如 primary/secondary/tertiary)
- **雙遷移模式**: 
  - **Versioned (DDL)**: 時間戳版本化，需要 up/down 遷移
  - **Repeatable (DCL)**: Checksum 驅動，自動偵測變更並重新執行
- **統一 CLI**: 單一命令行界面管理所有資料庫遷移
- **驗證規則**: 自動檢測危險操作、空 down()、孤立 drop、DCL 操作等問題
- **Up-Down-Up 測試**: 確保遷移可以正確回滾和重新應用
- **DCL 冪等性驗證**: 自動驗證 DCL 腳本執行多次結果相同
- **Sanity Check**: 內建 Pre-Check / Post-Check / Auto-Rollback 機制
- **報表生成**: 支援 JSON、HTML 格式
- **容器化**: Docker 和 Kubernetes (Helm) 部署支援

---

## 📦 安裝

```bash
# Clone repository
git clone https://github.com/your-org/db-migrate.git
cd db-migrate

# Install dependencies
npm install

# Link CLI globally (optional)
npm link
```

---

## 🚀 快速開始

### 1. 啟動測試資料庫

```bash
# 啟動 MongoDB 和 MariaDB
docker compose up -d mongodb mariadb

# 確認服務運行中
docker compose ps
```

### 2. 執行範例遷移

```bash
# MongoDB 範例 - 查看狀態
node src/cli.js -c databases/mongodb/test-success/ddl/config.js status

# MongoDB 範例 - 執行遷移
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up

# MariaDB 範例 - 查看狀態
node src/cli.js -c databases/mariadb/test-success/ddl/config.js status

# MariaDB 範例 - 執行遷移
node src/cli.js -c databases/mariadb/test-success/ddl/config.js up
```

---

## 📖 使用方式大全

### 基本配置檔格式

**MongoDB 配置** (`config.js`):
```javascript
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGO_URL || 'mongodb://localhost:27017',
    databaseName: process.env.MONGO_DB || 'myapp'
  },
  migrationsDir: './migrations',
  changelogCollection: 'changelog'
};
```

**MariaDB/MySQL 配置** (`config.js`):
```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'myapp',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'
};
```

**多實例配置 - MongoDB** (`config.js`):
```javascript
export default {
  type: 'mongodb',
  migrationsDir: './migrations',  // 共用遷移目錄
  
  instances: [
    {
      name: 'mongo-primary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_primary'
      },
      changelogCollection: 'changelog'
    },
    {
      name: 'mongo-secondary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_secondary'
      },
      changelogCollection: 'changelog'
    }
  ]
};
```

**多實例配置 - MariaDB/MySQL** (`config.js`):
```javascript
export default {
  type: 'mariadb',
  migrationsDir: './migrations',  // 共用遷移目錄
  
  instances: [
    {
      name: 'mariadb-primary',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_primary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    },
    {
      name: 'mariadb-secondary',
      mariadb: {
        host: 'localhost',
        port: 3307,
        database: 'app_secondary',
        user: 'root',
        password: 'password'
      },
      changelogTable: '_migrations'
    }
  ]
};
```

---

### � Container 操作 CLI

無需在本機安裝 Node.js，透過 Docker Compose 操作所有 CLI 指令。

`docker-compose.yml` 已定義 `migrate` 服務（`profiles: [tools]`），`entrypoint` 為 `node src/cli.js`，掛載 `./databases:/app/databases`，可直接傳入子指令。

#### 啟動環境

```bash
# 啟動資料庫
docker compose up -d mongodb mariadb

# 第一次使用需 build
docker compose build migrate
```

#### 所有指令一覽

以下所有指令格式：`docker compose run --rm migrate <command> [options] -c <config-path>`

---

##### `status` — 查看遷移狀態

```bash
docker compose run --rm migrate status -c /app/databases/mariadb/test-success/ddl/config.js
```

```
[STATUS] Database: mariadb
──────────────────────────────────────────────────

✅ Applied (6):
   20250101000001-create-users.sql - Mon Feb 09 2026 09:04:56 GMT+0000
   20250101000002-seed-users.sql - Mon Feb 09 2026 09:04:56 GMT+0000
   20250101000003-create-products.sql - Mon Feb 09 2026 09:04:57 GMT+0000
   20250101000004-create-orders.sql - Mon Feb 09 2026 09:04:57 GMT+0000
   20250101000005-add-user-profile.sql - Mon Feb 09 2026 09:04:57 GMT+0000
   20250101000006-add-phone-with-sanity.sql - Mon Feb 09 2026 09:04:57 GMT+0000

⏳ Pending (3):
   R__010_stored_procedures.sql
   R__011_dangerous_cleanup.sql
   R__012_blocked_dangerous.sql
```

---

##### `up` — 執行遷移

```bash
# 執行所有待處理遷移
docker compose run --rm migrate up -c /app/databases/mariadb/test-success/ddl/config.js

# Dry Run
docker compose run --rm migrate up --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# 啟用 Sanity Check
docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/test-success/ddl/config.js
```

```
[UP] Running migrations (mariadb)...

✅ Applied 1 migration(s):
   20250101000006-add-phone-with-sanity.sql
```

Dry Run 輸出：
```
[DRY RUN] Would apply these migrations:
   R__010_stored_procedures.sql
   R__011_dangerous_cleanup.sql
   R__012_blocked_dangerous.sql
```

---

##### `down` — 回滾遷移

```bash
# 回滾最後 1 筆
docker compose run --rm migrate down -n 1 -c /app/databases/mariadb/test-success/ddl/config.js

# 回滾最後 3 筆
docker compose run --rm migrate down -n 3 -c /app/databases/mariadb/test-success/ddl/config.js
```

```
[DOWN] Rolling back 1 migration(s) (mariadb)...

⏪ Rolled back 1 migration(s):
   20250101000006-add-phone-with-sanity.sql
```

---

##### `create` — 建立 DDL 遷移檔

```bash
docker compose run --rm migrate create add-orders-table -c /app/databases/mariadb/test-success/ddl/config.js
```

```
✅ Created: 20260210031512-add-orders-table.sql

Remember to:
1. Implement the UP section
2. Implement the DOWN section
3. Run validation: db-migrate validate -c <config>
```

---

##### `create-dcl` — 建立 DCL 遷移檔

```bash
# 自動流水號
docker compose run --rm migrate create-dcl readonly_users -c /app/databases/mariadb/test-success/dcl/config.js

# 指定流水號
docker compose run --rm migrate create-dcl app_service -n 004 -c /app/databases/mariadb/test-success/dcl/config.js
```

```
✅ Created: R__readonly_users.sql

Remember:
⚠️  DCL scripts must be IDEMPOTENT (safe to run multiple times)
1. Use IF NOT EXISTS / IF EXISTS patterns
2. DCL runs whenever checksum changes (no versioning)
3. Run verification: db-migrate dcl:verify -c <config>
```

---

##### `validate` — 驗證遷移檔案

```bash
# 嚴格驗證
docker compose run --rm migrate validate -c /app/databases/mariadb/test-success/ddl/config.js

# 放行危險操作
docker compose run --rm migrate validate --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js

# 放行特定操作
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/databases/mariadb/test-success/ddl/config.js
```

通過範例：
```
[VALIDATE] Checking migrations (mariadb)...

[OK] 20250101000001-create-users.sql
[OK] 20250101000002-seed-users.sql
[OK] 20250101000003-create-products.sql
   ⚠️  ⚠️ ON DELETE CASCADE may cause cascading deletes
[OK] 20250101000004-create-orders.sql
[OK] 20250101000005-add-user-profile.sql
[OK] 20250101000006-add-phone-with-sanity.sql
[OK] R__010_stored_procedures.sql
[OK] R__011_dangerous_cleanup.sql
[ERROR] R__012_blocked_dangerous.sql
   ⛔ [TRUNCATE_TABLE] 🟠 DATA LOSS: TRUNCATE TABLE will clear all data
   ⛔ [DROP_INDEX] 🟠 PERFORMANCE: DROP INDEX may affect query performance
   📊 forbidden:0 dangerous:2 warnings:1

──────────────────────────────────────────────────
Total: 9 file(s)
Valid: 8
Invalid: 1

💡 放行提示:
   🟠 危險操作放行: --allow-dangerous
      或指定: --allow TRUNCATE_TABLE,DROP_INDEX
```

失敗範例（DDL 中混入 DCL 操作）：
```
[VALIDATE] Checking migrations (mariadb)...

[ERROR] 20250101000002-dangerous-drop-database.sql
   ❌ [DROP_DATABASE] 🔴 DATA LOSS: Drop database is forbidden
[ERROR] 20250101000003-dangerous-dcl.sql
   ❌ [CREATE_USER] 🔴 DCL: User management should be in DCL project (Repeatable)
   ❌ [DROP_USER] 🔴 DCL: User management should be in DCL project (Repeatable)
   ❌ [GRANT] 🔴 DCL: Permission management should be in DCL project (Repeatable)
[ERROR] 20250101000005-orphan-drop.sql
   ❌ Orphan drop: DOWN drops 'legacy_table' but UP doesn't create it

──────────────────────────────────────────────────
Total: 10 file(s)
Valid: 1
Invalid: 9

💡 放行提示:
   🟠 危險操作放行: --allow-dangerous
   🔴 禁止操作放行: --allow-forbidden (需團隊審批)
```

---

##### `baseline` — 標記既有遷移為已執行

```bash
# 標記全部（Dry Run）
docker compose run --rm migrate baseline --all --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# 正式標記
docker compose run --rm migrate baseline --all -c /app/databases/mariadb/test-success/ddl/config.js

# 標記到指定版本
docker compose run --rm migrate baseline --up-to 20250101000003-create-products.sql -c /app/databases/mariadb/test-success/ddl/config.js
```

```
[BASELINE] Marking existing migrations as applied (mariadb)...

📋 Will mark 6 migration(s) as applied:
   20250101000001-create-users.sql
   20250101000002-seed-users.sql
   20250101000003-create-products.sql
   20250101000004-create-orders.sql
   20250101000005-add-user-profile.sql
   20250101000006-add-phone-with-sanity.sql

   [DRY RUN] No changes made.
```

---

##### `test` — Up-Down-Up 測試

```bash
docker compose run --rm migrate test -c /app/databases/mariadb/test-success/ddl/config.js
```

```
🧪 Running Up-Down-Up Test (mariadb)...

══════════════════════════════════════════════════

📤 Stage 1: Running UP migrations...
   ✅ Applied 6 migrations

📥 Stage 2: Running DOWN migrations (rollback)...
   ✅ Rolled back 6 migrations

📤 Stage 3: Running UP migrations again...
   ✅ Re-applied 6 migrations

══════════════════════════════════════════════════

✅ Up-Down-Up Test PASSED!
```

---

##### `dcl` — 執行 DCL Repeatable 遷移

```bash
docker compose run --rm migrate dcl -c /app/databases/mariadb/test-success/dcl/config.js

# Dry Run
docker compose run --rm migrate dcl --dry-run -c /app/databases/mariadb/test-success/dcl/config.js
```

```
[DCL] Running repeatable migrations (mariadb)...

✅ Applied 2 DCL migration(s):
   R__001_create_app_user.sql (checksum changed)
   R__002_create_readonly_user.sql (checksum changed)
```

---

##### `dcl:status` — 查看 DCL 狀態

```bash
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/test-success/dcl/config.js
```

```
[DCL STATUS] Database: mariadb
──────────────────────────────────────────────────

⏳ Pending (0):

✅ Up-to-date (3):
   R__001_create_app_user.sql
      Applied: Tue Feb 10 2026 03:15:46 GMT+0000
   R__002_create_readonly_user.sql
      Applied: Tue Feb 10 2026 03:15:46 GMT+0000
   R__003_admin_users.sql
      Applied: Mon Feb 09 2026 09:06:24 GMT+0000
```

---

##### `dcl:verify` — 驗證 DCL 冪等性

```bash
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/test-success/dcl/config.js
```

```
[DCL VERIFY] Testing idempotency (mariadb)...

══════════════════════════════════════════════════

📄 R__001_create_app_user.sql
   🔍 Testing idempotency for: R__001_create_app_user.sql
   🔍 Execution 1...
   🔍 Capturing state after execution 1...
   🔍 Execution 2...
   🔍 Capturing state after execution 2...
   🔍 ✅ Idempotency verified - states are identical
   ✅ IDEMPOTENT

📄 R__002_create_readonly_user.sql
   ✅ IDEMPOTENT

📄 R__003_admin_users.sql
   ✅ IDEMPOTENT

══════════════════════════════════════════════════

✅ All DCL scripts are idempotent!
```

---

##### `status-all` — 多實例狀態

```bash
docker compose run --rm migrate status-all -c /app/databases/mariadb/multi-instance/ddl/config.js
```

```
📊 Status for 2 database instance(s):

════════════════════════════════════════════════════════════

[primary-db] (mariadb)
  ✅ Applied: 5
  ⏳ Pending: 0

[secondary-db] (mariadb)
  ✅ Applied: 5
  ⏳ Pending: 0

════════════════════════════════════════════════════════════
```

---

##### `up-all` — 多實例執行遷移

```bash
docker compose run --rm migrate up-all -c /app/databases/mariadb/multi-instance/ddl/config.js

# Dry Run
docker compose run --rm migrate up-all --dry-run -c /app/databases/mariadb/multi-instance/ddl/config.js
```

```
🚀 Running migrations on 2 instance(s)...

[primary-db] ✅ Applied 3 migration(s)
[secondary-db] ✅ Applied 3 migration(s)
```

---

##### `test-instances` — 多實例測試

```bash
docker compose run --rm migrate test-instances -c /app/databases/mariadb/multi-instance/ddl/config.js

# 只驗證（跳過 Up-Down-Up）
docker compose run --rm migrate test-instances --validate-only -c /app/databases/mariadb/multi-instance/ddl/config.js

# 平行執行
docker compose run --rm migrate test-instances --parallel -c /app/databases/mariadb/multi-instance/ddl/config.js
```

```
🔗 Found 2 database instance(s):

   • primary-db (mariadb)
   • secondary-db (mariadb)

══════════════════════════════════════════════════════════════════════
                    📊 MIGRATION TEST REPORT
══════════════════════════════════════════════════════════════════════
  Database             Type       Test            Status     Duration
  ──────────────────────────────────────────────────────────────────
  primary-db           mariadb    up-down-up      ✅ PASS     1.23s
  secondary-db         mariadb    up-down-up      ✅ PASS     1.15s
  ──────────────────────────────────────────────────────────────────

  SUMMARY:
  Total Tests:    2
  Passed:         2 ✅
  Pass Rate:      100.0%

  ╔════════════════════════════════════════════════════════════════╗
  ║               ✅ ALL TESTS PASSED SUCCESSFULLY                 ║
  ╚════════════════════════════════════════════════════════════════╝
```

---

##### `test-all` — 掃描所有專案測試

```bash
docker compose run --rm migrate test-all

# 指定報表輸出
docker compose run --rm migrate test-all -o /app/reports
```

```
══════════════════════════════════════════════════════════════════════
                    📊 MIGRATION TEST REPORT
══════════════════════════════════════════════════════════════════════
  Database             Type       Test            Status     Duration
  ──────────────────────────────────────────────────────────────────
  test-success         mariadb    up-down-up      ✅ PASS     1.50s
  test-success         mongodb    up-down-up      ✅ PASS     0.80s
  ──────────────────────────────────────────────────────────────────

  SUMMARY:
  Total Tests:    2
  Passed:         2 ✅
  Pass Rate:      100.0%

  ╔════════════════════════════════════════════════════════════════╗
  ║               ✅ ALL TESTS PASSED SUCCESSFULLY                 ║
  ╚════════════════════════════════════════════════════════════════╝
```

---

##### `dcl-all` — 多實例 DCL 遷移

```bash
docker compose run --rm migrate dcl-all -c /app/databases/mariadb/multi-instance/dcl/config.js
```

```
🔐 Running DCL migrations on 2 instance(s)...

[primary-db] Running DCL migrations...
   ✅ Applied 2 DCL migration(s)
      - R__001_create_readonly_user.sql (new file)
      - R__002_create_readwrite_user.sql (new file)

[secondary-db] Running DCL migrations...
   All DCL migrations are up-to-date.
```

---

##### `dcl:status-all` — 多實例 DCL 狀態

```bash
docker compose run --rm migrate dcl:status-all -c /app/databases/mariadb/multi-instance/dcl/config.js
```

```
📊 DCL Status for 2 instance(s):

════════════════════════════════════════════════════════════

[primary-db] (mariadb)
────────────────────────────────────────
  ⏳ Pending: 0
  ✅ Up-to-date: 2

[secondary-db] (mariadb)
────────────────────────────────────────
  ⏳ Pending: 0
  ✅ Up-to-date: 2

════════════════════════════════════════════════════════════
```

---

##### `dcl:verify-all` — 多實例 DCL 冪等性驗證

```bash
docker compose run --rm migrate dcl:verify-all -c /app/databases/mariadb/multi-instance/dcl/config.js
```

```
🔍 Verifying DCL idempotency on 2 instance(s)...

════════════════════════════════════════════════════════════

[primary-db] (mariadb)
────────────────────────────────────────
  📄 R__001_create_readonly_user.sql
     ✅ IDEMPOTENT
  📄 R__002_create_readwrite_user.sql
     ✅ IDEMPOTENT

[secondary-db] (mariadb)
────────────────────────────────────────
  📄 R__001_create_readonly_user.sql
     ✅ IDEMPOTENT
  📄 R__002_create_readwrite_user.sql
     ✅ IDEMPOTENT

════════════════════════════════════════════════════════════

✅ All DCL scripts are idempotent on all instances!
```

> **路徑說明**: 容器內路徑固定以 `/app/databases/` 開頭。`config.js` 中的 `migrationsDir: './migrations'` 是相對路徑，不需要改。

---

### �🔷 CLI 指令詳解

#### 1. 查看遷移狀態 (`status`)

```bash
# 基本用法
node src/cli.js -c <config-path> status

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js status
```

輸出範例：
```
[STATUS] Database: mongodb
──────────────────────────────────────────────────

✅ Applied (3):
   20250101000001-create-users.js - 2025-01-15T10:30:00.000Z
   20250101000002-seed-users.js - 2025-01-15T10:30:01.000Z
   20250101000003-create-products.js - 2025-01-15T10:30:02.000Z

⏳ Pending (2):
   20250101000004-create-orders.js
   20250101000005-add-user-profile.js
```

#### 2. 執行遷移 (`up`)

```bash
# 執行所有待處理的遷移
node src/cli.js -c <config-path> up

# Dry Run - 只顯示會執行什麼，不實際執行
node src/cli.js -c <config-path> up --dry-run

# 啟用 Sanity Check (Pre-Check / Post-Check / Auto-Rollback)
node src/cli.js -c <config-path> up --sanity-check

# 啟用 Sanity Check 但禁用自動回滾
node src/cli.js -c <config-path> up --sanity-check --no-auto-rollback

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up
node src/cli.js -c databases/mariadb/test-success/ddl/config.js up --dry-run
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up --sanity-check
```

#### 3. 回滾遷移 (`down`)

```bash
# 回滾最後一個遷移
node src/cli.js -c <config-path> down

# 回滾指定數量的遷移
node src/cli.js -c <config-path> down -n <count>

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js down -n 1
node src/cli.js -c databases/mongodb/test-success/ddl/config.js down -n 3
```

#### 4. 建立新遷移 (`create`)

```bash
# 建立新 DDL (versioned) 遷移檔案
node src/cli.js -c <config-path> create <migration-name>

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js create add-user-avatar
node src/cli.js -c databases/mariadb/test-success/ddl/config.js create create-orders-table
```

輸出：
```
✅ Created: 20250120123456-add-user-avatar.js

Remember to:
1. Implement the UP section
2. Implement the DOWN section
3. Run validation: db-migrate validate -c <config>
```

#### 4b. 建立 DCL 遷移 (`create-dcl`)

```bash
# 建立新 DCL (repeatable) 遷移檔案，自動加上 R__ 前綴
node src/cli.js -c <config-path> create-dcl <migration-name>

# 指定流水號
node src/cli.js -c <config-path> create-dcl <migration-name> -n 003

# 範例
node src/cli.js -c databases/mariadb/production-server/dcl/config.js create-dcl readonly_users
node src/cli.js -c databases/mariadb/production-server/dcl/config.js create-dcl app_service_account -n 004
```

輸出：
```
✅ Created: R__003_readonly_users.sql
```

#### 4c. 標記既有遷移 (`baseline`)

對已有資料的資料庫，將現有遷移標記為「已執行」而不實際執行 SQL：

```bash
# 標記所有遷移為已執行
node src/cli.js -c <config-path> baseline --all

# 標記到指定版本（含）
node src/cli.js -c <config-path> baseline --up-to 20260101000003-create-orders.sql

# 標記單一檔案
node src/cli.js -c <config-path> baseline --file 20260101000001-create-users.sql

# Dry Run - 查看會標記哪些，不實際執行
node src/cli.js -c <config-path> baseline --all --dry-run

# 範例
node src/cli.js -c databases/mariadb/production-server/ddl/ecommerce/config.js baseline --all
```

#### 5. 驗證遷移檔案 (`validate`)

```bash
# 驗證所有遷移檔案
node src/cli.js -c <config-path> validate

# 允許危險操作 (🟠 level)
node src/cli.js -c <config-path> validate --allow-dangerous

# 允許禁止操作 (🔴 level) - 需團隊審批
node src/cli.js -c <config-path> validate --allow-forbidden

# 允許特定操作代碼
node src/cli.js -c <config-path> validate --allow TRUNCATE_TABLE,DROP_COLUMN

# 組合使用
node src/cli.js -c <config-path> validate --allow-dangerous --allow DROP_DATABASE

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js validate
node src/cli.js -c databases/mongodb/test-failure/ddl/config.js validate
```

輸出範例：
```
[VALIDATE] Checking migrations (mariadb)...

[OK] 20250101000001-create-users.sql
[ERROR] 20250101000002-dangerous-drop-database.sql
   ❌ [DROP_DATABASE] 🔴 DATA LOSS: 禁止刪除資料庫
   📊 forbidden:1 dangerous:0 warnings:0
[ERROR] 20250101000003-dangerous-truncate.sql
   ⛔ [TRUNCATE_TABLE] 🟠 DATA LOSS: TRUNCATE TABLE 會清空全表資料
      └─ 建議: 建議改用 DELETE FROM table WHERE condition
   📊 forbidden:0 dangerous:1 warnings:0

──────────────────────────────────────────────────
Total: 3 file(s)
Valid: 1
Invalid: 2

💡 放行提示:
   🟠 危險操作放行: --allow-dangerous
      或指定: --allow TRUNCATE_TABLE
   🔴 禁止操作放行: --allow-forbidden (需團隊審批)
      或指定: --allow DROP_DATABASE
```

---

### 🛡️ 危險操作放行機制

驗證系統將操作分為三個等級：

| 等級 | 符號 | 說明 | 放行方式 |
|------|------|------|----------|
| 🔴 Forbidden | ❌ | 絕對禁止，極度危險 | `--allow-forbidden` 或 `--allow <CODE>` |
| 🟠 Dangerous | ⛔ | 危險操作，需謹慎 | `--allow-dangerous` 或 `--allow <CODE>` |
| 🟡 Warning | ⚠️ | 警告提示，不阻擋 | 無需放行，僅提示 |

#### 🔴 Forbidden 操作代碼 (MariaDB)

| 代碼 | 說明 |
|------|------|
| `DROP_DATABASE` | DROP DATABASE - 刪除整個資料庫 |
| `DROP_SCHEMA` | DROP SCHEMA - 刪除 Schema |
| `CREATE_USER` | CREATE USER - 建立使用者 |
| `DROP_USER` | DROP USER - 刪除使用者 |
| `ALTER_USER` | ALTER USER - 修改使用者 |
| `SET_PASSWORD` | SET PASSWORD - 設定密碼 |
| `GRANT` | GRANT - 授權 |
| `REVOKE` | REVOKE - 撤銷權限 |
| `FLUSH_PRIVILEGES` | FLUSH PRIVILEGES - 重載權限 |
| `INTO_OUTFILE` | SELECT INTO OUTFILE - 匯出到檔案 |
| `LOAD_DATA` | LOAD DATA INFILE - 從檔案載入 |
| `SHUTDOWN` | SHUTDOWN - 關閉資料庫 |
| `RESET_MASTER` | RESET MASTER - 重置主庫 |
| `SET_GLOBAL` | SET GLOBAL - 變更全域設定 |

#### 🔴 Forbidden 操作代碼 (MongoDB)

| 代碼 | 說明 |
|------|------|
| `DROP_DATABASE` | dropDatabase() - 刪除資料庫 |
| `CREATE_USER` / `CREATE_USER_CMD` | createUser - 建立使用者 |
| `DROP_USER` / `DROP_USER_CMD` | dropUser - 刪除使用者 |
| `UPDATE_USER` / `UPDATE_USER_CMD` | updateUser - 更新使用者 |
| `GRANT_ROLES` / `GRANT_ROLES_CMD` | grantRolesToUser - 授權角色 |
| `REVOKE_ROLES` / `REVOKE_ROLES_CMD` | revokeRolesFromUser - 撤銷角色 |
| `CREATE_ROLE` / `CREATE_ROLE_CMD` | createRole - 建立角色 |
| `DROP_ROLE` / `DROP_ROLE_CMD` | dropRole - 刪除角色 |
| `SHUTDOWN` | shutdown - 關閉資料庫 |
| `REPL_RECONFIG` | replSetReconfig - 重設 Replica Set |
| `SET_PARAMETER` | setParameter - 設定系統參數 |

#### 🟠 Dangerous 操作代碼 (MariaDB)

| 代碼 | 說明 |
|------|------|
| `TRUNCATE_TABLE` | TRUNCATE TABLE - 清空表 |
| `LOCK_TABLE` | LOCK TABLE - 鎖表 |
| `ALTER_TABLE_MODIFY` | ALTER TABLE MODIFY/CHANGE COLUMN - 可能重建表並鎖表 |
| `ALTER_TABLE_REBUILD` | ALTER TABLE CONVERT TO / ENGINE= - 需完整重建表 |
| `SELECT_FOR_UPDATE` | SELECT FOR UPDATE - 排他鎖 |
| `DELETE_ALL` | DELETE 無 WHERE - 刪除全表 |
| `UPDATE_ALL` | UPDATE 無 WHERE - 更新全表 |
| `INSERT_SELECT` | INSERT...SELECT - 可能鎖表 |
| `DROP_COLUMN` | DROP COLUMN - 刪除欄位 |
| `RENAME_TABLE` | RENAME TABLE - 重命名表 |
| `DROP_INDEX` | DROP INDEX - 刪除索引 |
| `DROP_KEY` | DROP KEY - 刪除主鍵 |
| `DROP_FOREIGN_KEY` | DROP FOREIGN KEY - 刪除外鍵 |

#### 🟠 Dangerous 操作代碼 (MongoDB)

| 代碼 | 說明 |
|------|------|
| `DROP_COLLECTION` | drop() - 刪除 Collection |
| `DELETE_ALL` | deleteMany({}) - 刪除所有文件 |
| `UPDATE_ALL` | updateMany({}, ...) - 更新所有文件 |
| `REPLACE_ONE` | replaceOne - 取代文件 |
| `DROP_INDEX` | dropIndex - 刪除索引 |
| `DROP_INDEXES` | dropIndexes - 刪除所有索引 |
| `RENAME_FIELD` | $rename - 重命名欄位 |
| `UNSET_FIELD` | $unset - 刪除欄位 |
| `RENAME_COLLECTION` | renameCollection - 重命名 Collection |
| `VALIDATION_ERROR` | validationAction: "error" |
| `VALIDATION_STRICT` | validationLevel: "strict" |

#### 放行範例

```bash
# 情境 1: 需要執行 TRUNCATE TABLE (清理測試資料)
node src/cli.js -c config.js validate --allow TRUNCATE_TABLE

# 情境 2: 批准多個危險操作
node src/cli.js -c config.js validate --allow TRUNCATE_TABLE,DROP_COLUMN,DROP_INDEX

# 情境 3: 批准所有危險操作 (需在 PR 中說明理由)
node src/cli.js -c config.js validate --allow-dangerous

# 情境 4: 特殊情況需要 DROP DATABASE (需團隊 Lead 審批)
node src/cli.js -c config.js validate --allow-forbidden

# 情境 5: 只允許特定禁止操作
node src/cli.js -c config.js validate --allow DROP_DATABASE

# 情境 6: 組合使用 - 允許所有危險操作 + 特定禁止操作
node src/cli.js -c config.js validate --allow-dangerous --allow DROP_DATABASE
```

#### CI/CD 整合

在 CI/CD pipeline 中使用放行機制：

```yaml
# azure-pipelines.yml
- script: |
    # 標準驗證 - 不放行任何危險操作
    node src/cli.js -c $CONFIG_PATH validate
  displayName: 'Validate Migrations (Strict)'

# 或者在特殊分支允許危險操作
- script: |
    if [ "$BUILD_REASON" = "PullRequest" ]; then
      # PR 階段：嚴格驗證
      node src/cli.js -c $CONFIG_PATH validate
    else
      # Release 分支：允許已審批的危險操作
      node src/cli.js -c $CONFIG_PATH validate --allow $APPROVED_CODES
    fi
  displayName: 'Validate Migrations (Conditional)'
```

#### 團隊審批流程建議

```
1. 開發者提交含危險操作的 Migration
2. CI 驗證失敗，顯示需要放行的代碼
3. 開發者在 PR 說明中解釋為何需要該操作
4. Team Lead 審核並批准
5. 在 CI 變數中加入 APPROVED_CODES
6. 重新執行 CI
```

#### 6. Up-Down-Up 測試 (`test`)

```bash
# 執行單一實例的 Up-Down-Up 測試
node src/cli.js -c <config-path> test

# 範例
node src/cli.js -c databases/mongodb/test-success/ddl/config.js test
```

測試流程：
```
1. 🔼 UP   - 執行所有遷移
2. 🔽 DOWN - 回滾所有遷移  
3. 🔼 UP   - 再次執行所有遷移
4. ✅ VERIFY - 確認狀態一致
```

---

### 🔷 多實例指令

#### 7. 測試所有實例 (`test-instances`)

```bash
# 測試所有配置中的資料庫實例
node src/cli.js -c <config-path> test-instances

# 只執行驗證（跳過 Up-Down-Up 測試）
node src/cli.js -c <config-path> test-instances --validate-only

# 平行執行（更快但更耗資源）
node src/cli.js -c <config-path> test-instances --parallel

# 指定報表輸出目錄
node src/cli.js -c <config-path> test-instances -o ./reports

# 範例
node src/cli.js -c databases/mongodb/multi-instance/ddl/config.js test-instances
```

#### 8. 查看所有實例狀態 (`status-all`)

```bash
# 查看所有實例的遷移狀態
node src/cli.js -c <config-path> status-all

# 範例
node src/cli.js -c databases/mongodb/multi-instance/ddl/config.js status-all
```

輸出範例：
```
📊 Status for 3 database instance(s):

════════════════════════════════════════════════════════════

[mongo-primary] (mongodb)
────────────────────────────────────────
  ✅ Applied: 5
  ⏳ Pending: 0

[mongo-secondary] (mongodb)
────────────────────────────────────────
  ✅ Applied: 3
  ⏳ Pending: 2
     Pending migrations:
       - 20250101000004-create-orders.js
       - 20250101000005-add-user-profile.js

════════════════════════════════════════════════════════════
```

#### 9. 對所有實例執行遷移 (`up-all`)

```bash
# 對所有實例執行遷移
node src/cli.js -c <config-path> up-all

# Dry Run
node src/cli.js -c <config-path> up-all --dry-run

# 範例
node src/cli.js -c databases/mongodb/multi-instance/ddl/config.js up-all
```

#### 10. 測試所有資料庫 (`test-all`)

```bash
# 掃描 databases/ 目錄下所有配置並測試
node src/cli.js test-all

# 指定報表輸出目錄
node src/cli.js test-all -o ./reports

# 範例（不需要 -c 參數）
node src/cli.js test-all -o ./test-reports
```

---

### 🔷 DCL Repeatable 遷移指令

DCL (Data Control Language) 遷移使用 **Repeatable 模式**，適用於管理資料庫使用者和權限。

#### 11. 執行 DCL 遷移 (`dcl`)

```bash
# 執行所有有變更的 DCL 遷移
node src/cli.js -c databases/mariadb/production-server/dcl/config.js dcl

# Dry Run - 查看會執行什麼
node src/cli.js -c databases/mariadb/production-server/dcl/config.js dcl --dry-run

# MongoDB DCL
node src/cli.js -c databases/mongodb/production-server/dcl/config.js dcl
```

輸出範例：
```
[DCL] Running repeatable migrations (mariadb)...

✅ Applied 2 DCL migration(s):
   R__01_readonly_users.sql (new file)
   R__02_readwrite_users.sql (checksum changed)
```

#### 12. 查看 DCL 狀態 (`dcl:status`)

```bash
# 查看 DCL 遷移狀態
node src/cli.js -c databases/mariadb/production-server/dcl/config.js dcl:status
```

輸出範例：
```
[DCL STATUS] Database: mariadb
──────────────────────────────────────────────────

⏳ Pending (1):
   R__03_ddl_admin.sql
      Reason: checksum changed

✅ Up-to-date (2):
   R__01_readonly_users.sql
      Applied: 2026-01-20T10:30:00.000Z
   R__02_readwrite_users.sql
      Applied: 2026-01-20T10:30:01.000Z
```

#### 13. 驗證 DCL 冪等性 (`dcl:verify`)

```bash
# 驗證所有 DCL 腳本都是冪等的（執行兩次結果相同）
node src/cli.js -c databases/mariadb/production-server/dcl/config.js dcl:verify
```

輸出範例：
```
[DCL VERIFY] Testing idempotency (mariadb)...
══════════════════════════════════════════════════

📄 R__01_readonly_users.sql
   🔍 Testing idempotency for: R__01_readonly_users.sql
   🔍 Execution 1...
   🔍 Capturing state after execution 1...
   🔍 Execution 2...
   🔍 Capturing state after execution 2...
   🔍 ✅ Idempotency verified - states are identical
   ✅ IDEMPOTENT

📄 R__02_readwrite_users.sql
   ✅ IDEMPOTENT

══════════════════════════════════════════════════

✅ All DCL scripts are idempotent!
```

#### 14. 多實例 DCL 遷移 (`dcl-all`)

```bash
# 對所有實例執行 DCL repeatable 遷移
node src/cli.js -c <config-path> dcl-all

# Dry Run
node src/cli.js -c <config-path> dcl-all --dry-run

# 啟用驗證
node src/cli.js -c <config-path> dcl-all --validate

# 範例
node src/cli.js -c databases/mariadb/multi-instance/dcl/config.js dcl-all
```

#### 15. 多實例 DCL 狀態 (`dcl:status-all`)

```bash
# 查看所有實例的 DCL 遷移狀態
node src/cli.js -c <config-path> dcl:status-all

# 範例
node src/cli.js -c databases/mariadb/multi-instance/dcl/config.js dcl:status-all
```

#### 16. 多實例 DCL 冪等性驗證 (`dcl:verify-all`)

```bash
# 驗證所有實例的 DCL 腳本都是冪等的
node src/cli.js -c <config-path> dcl:verify-all

# 範例
node src/cli.js -c databases/mariadb/multi-instance/dcl/config.js dcl:verify-all
```

---

### 🔷 DDL vs DCL 目錄結構

```
databases/
├── mariadb/
│   ├── _templates/                       # 新專案模板
│   │   ├── dcl/
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── ddl/
│   │       ├── config.js
│   │       └── migrations/
│   ├── multi-instance/                    # 多實例配置 (同 schema → 多 DB)
│   │   ├── dcl/
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── ddl/
│   │       ├── config.js
│   │       └── migrations/
│   ├── production-server/                 # 生產環境 (多 DB 各自 schema)
│   │   ├── dcl/                           # DCL - Repeatable 模式 (Platform Team)
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   │       ├── R__01_readonly_users.sql
│   │   │       ├── R__02_readwrite_users.sql
│   │   │       └── R__03_ddl_admin.sql
│   │   └── ddl/                           # DDL - Versioned 模式 (Dev Team)
│   │       ├── ecommerce/
│   │       │   ├── config.js
│   │       │   └── migrations/
│   │       │       ├── 20260101000001-create-users.sql
│   │       │       └── 20260101000002-create-products.sql
│   │       ├── analytics/
│   │       │   ├── config.js
│   │       │   └── migrations/
│   │       │       ├── 20260101000001-create-events.sql
│   │       │       └── 20260101000002-create-daily-stats.sql
│   │       └── logging/
│   │           ├── config.js
│   │           └── migrations/
│   │               ├── 20260101000001-create-app-logs.sql
│   │               └── 20260101000002-create-audit-trail.sql
│   ├── test-success/
│   └── test-failure/
└── mongodb/
    ├── multi-instance/
    │   ├── dcl/
    │   └── ddl/
    └── production-server/
        ├── dcl/
        │   ├── config.js
        │   └── migrations/
        └── ddl/
            └── ecommerce/
                ├── config.js
                └── migrations/
```

---

### 🔷 實用範例

#### 開發環境工作流程

```bash
# 1. 啟動資料庫
docker compose up -d mongodb mariadb

# 2. 建立新遷移
node src/cli.js -c databases/mongodb/test-success/ddl/config.js create add-user-roles

# 3. 編輯遷移檔案（實現 up/down 函數）

# 4. 驗證遷移
node src/cli.js -c databases/mongodb/test-success/ddl/config.js validate

# 5. 執行遷移（先 dry-run）
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up --dry-run

# 6. 正式執行
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up

# 7. 測試回滾
node src/cli.js -c databases/mongodb/test-success/ddl/config.js test
```

#### CI/CD 整合

```bash
# 在 CI pipeline 中驗證所有遷移
node src/cli.js -c databases/mongodb/test-success/ddl/config.js validate || exit 1

# 執行完整測試
node src/cli.js -c databases/mongodb/test-success/ddl/config.js test || exit 1

# 部署時執行遷移
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up
```

#### 多環境部署

```bash
# 使用環境變數切換環境
MONGO_URL=mongodb://prod-server:27017 \
MONGO_DB=production_db \
node src/cli.js -c databases/mongodb/test-success/ddl/config.js up

# 或建立環境特定配置
node src/cli.js -c databases/mongodb/production/config.js status
node src/cli.js -c databases/mongodb/staging/config.js up
```

---

## 📁 專案結構

```
db-migrate/
├── src/
│   ├── cli.js                      # 統一 CLI 入口
│   ├── check-db.js                  # 資料庫可用性檢查
│   ├── core/
│   │   ├── base-adapter.js         # 適配器基類
│   │   ├── reporter.js             # 報表生成器
│   │   ├── sanity-checker.js       # Sanity Check 框架
│   │   ├── repeatable-runner.js    # DCL Repeatable 遷移執行器
│   │   └── dcl-idempotent-checker.js # DCL 冪等性驗證器
│   └── adapters/
│       ├── index.js                # 適配器工廠
│       ├── mongodb-adapter.js      # MongoDB 適配器
│       └── mariadb-adapter.js      # MariaDB 適配器
├── databases/
│   ├── mongodb/
│   │   ├── _templates/             # 新專案模板 (dcl/ + ddl/)
│   │   ├── test-success/           # MongoDB 成功案例
│   │   ├── test-failure/           # MongoDB 失敗案例（驗證用）
│   │   ├── multi-instance/         # 多實例配置（dcl/ + ddl/）
│   │   └── production-server/      # 生產伺服器範例
│   │       ├── dcl/                # DCL Repeatable 遷移
│   │       └── ddl/                # DDL Versioned 遷移
│   └── mariadb/
│       ├── _templates/             # 新專案模板 (dcl/ + ddl/)
│       ├── test-success/           # MariaDB 成功案例
│       ├── test-failure/           # MariaDB 失敗案例
│       ├── multi-instance/         # 多實例配置（dcl/ + ddl/）
│       └── production-server/      # 生產伺服器（3 DB: ecommerce/analytics/logging）
│           ├── dcl/                # DCL Repeatable 遷移
│           └── ddl/                # DDL Versioned 遷移（每個 DB 獨立子目錄）
├── charts/
│   └── db-migrate/                 # Helm Chart（含 ConfigMap 多 DB 模式）
│       ├── templates/
│       │   ├── configmap.yaml      # 每個 DB 一個 ConfigMap（DDL+DCL 合併）
│       │   ├── migration-jobs.yaml # DDL/DCL Jobs（每 DB 各一組）
│       │   └── ...
│       ├── values.yaml             # 預設 values
│       └── values-multi-db.yaml    # 多 DB 範例 values
├── docker/
│   └── entrypoint.sh               # Docker/K8s 入口腳本
├── scripts/
│   ├── gen-values.py               # 從專案目錄自動產生 Helm values.yaml
│   ├── build-migration-image.sh    # 建置 Migration Docker 映像
│   ├── ci-migration-test.sh        # CI 遷移測試腳本
│   ├── full-migration-test.sh      # 完整遷移測試
│   ├── local-test.sh               # 本地測試腳本
│   ├── setup-k8s-dev.sh            # K8s 開發環境設定
│   └── run-tests.sh                # 測試執行腳本
├── Dockerfile                      # 多階段 Dockerfile
├── Dockerfile.migrations           # Migration 映像 Dockerfile
└── docker-compose.yml              # 開發環境 Compose
```

---

## 🔧 遷移檔案格式

### MongoDB (.js)

```javascript
// 20250101000001-create-users.js
export async function up(db, client) {
  // 建立 Collection 並設定 Schema 驗證
  await db.createCollection('users', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['email', 'name'],
        properties: {
          email: { bsonType: 'string', description: 'User email' },
          name: { bsonType: 'string' },
          createdAt: { bsonType: 'date' }
        }
      }
    }
  });
  
  // 建立索引
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### MongoDB with Sanity Check (.js)

```javascript
// 20250101000002-add-phone-field.js

// Pre-Check: 在執行前驗證前置條件
export const preCheck = async ({ db }) => {
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    return { success: false, error: 'Collection "users" does not exist' };
  }
  return { success: true, details: ['Collection "users" exists'] };
};

// Up Migration
export const up = async (db, client) => {
  await db.collection('users').updateMany(
    { phone: { $exists: false } },
    { $set: { phone: '', phoneVerified: false } }
  );
  await db.collection('users').createIndex({ phone: 1 }, { sparse: true });
};

// Post-Check (Sanity Check): 驗證遷移結果
export const postCheck = async ({ db }) => {
  const missing = await db.collection('users').countDocuments({ 
    phone: { $exists: false } 
  });
  if (missing > 0) {
    return { success: false, error: `${missing} documents missing phone field` };
  }
  return { success: true, details: ['All users have phone field'] };
};

// Down Migration
export const down = async (db, client) => {
  await db.collection('users').dropIndex('phone_1');
  await db.collection('users').updateMany({}, { $unset: { phone: '', phoneVerified: '' } });
};
```

### MariaDB/MySQL (.sql)

```sql
-- 20250101000001-create-users.sql

-- +migrate Up
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_users_name ON users(name);

-- +migrate Down
DROP TABLE IF EXISTS users;
```

### MariaDB/MySQL with Sanity Check (.sql)

```sql
-- 20250101000002-add-phone-column.sql

-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone'
-- END_CHECK

-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_name='users' AND index_name='idx_users_phone'
-- END_CHECK

-- +migrate Down
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone_verified;
ALTER TABLE users DROP COLUMN phone;
```

---

## ✅ 驗證規則

工具會自動檢測以下問題：

### MongoDB 驗證規則

| 類別 | 操作 | 嚴重性 |
|------|------|--------|
| **危險操作** | `dropDatabase`, `dropAllUsers`, `dropAllRoles` | ❌ Error |
| **DCL 操作** | `createUser`, `dropUser`, `updateUser` | ⚠️ Warning |
| **DCL 操作** | `createRole`, `dropRole`, `grantRolesToUser` | ⚠️ Warning |
| **DCL 操作** | `revokeRolesFromUser`, `shutdown` | ⚠️ Warning |
| **空 down()** | up() 有操作但 down() 空白 | ❌ Error |
| **孤立 drop** | down() 刪除非 up() 建立的集合 | ❌ Error |
| **非冪等操作** | `deleteMany({})`, `drop()` 不帶條件 | ⚠️ Warning |

### MariaDB/MySQL 驗證規則

| 類別 | 操作 | 嚴重性 |
|------|------|--------|
| **危險操作** | `DROP DATABASE`, `DROP SCHEMA` | ❌ Error |
| **危險操作** | `TRUNCATE TABLE` | ❌ Error |
| **DCL 操作** | `CREATE USER`, `DROP USER`, `ALTER USER` | ⚠️ Warning |
| **DCL 操作** | `GRANT`, `REVOKE`, `SET PASSWORD` | ⚠️ Warning |
| **DCL 操作** | `FLUSH PRIVILEGES` | ⚠️ Warning |
| **資料匯出** | `INTO OUTFILE`, `LOAD DATA INFILE` | ⚠️ Warning |
| **空 Down** | Up 有 SQL 但 Down 空白 | ❌ Error |
| **孤立 drop** | Down 刪除非 Up 建立的表 | ❌ Error |

---

## 🧪 測試

### 本地測試

```bash
# 啟動測試資料庫
docker compose up -d mongodb mariadb

# 等待資料庫就緒
sleep 10

# 執行驗證測試
node src/cli.js -c databases/mongodb/test-success/ddl/config.js validate
node src/cli.js -c databases/mariadb/test-success/ddl/config.js validate

# 執行危險操作檢測測試（應該失敗）
node src/cli.js -c databases/mongodb/test-failure/ddl/config.js validate
node src/cli.js -c databases/mariadb/test-failure/ddl/config.js validate

# 執行 Up-Down-Up 測試
node src/cli.js -c databases/mongodb/test-success/ddl/config.js test
node src/cli.js -c databases/mariadb/test-success/ddl/config.js test

# 執行所有測試並生成報表
node src/cli.js test-all -o ./reports
```

### 使用測試腳本

```bash
# 執行完整測試套件
./scripts/run-tests.sh

# 使用 Docker 執行
./scripts/run-tests.sh --docker
```

---

## 🐳 Docker 使用

### 建置映像檔

```bash
# 建置 production 映像
docker build -t db-migrate:2.0.0 --target production .

# 建置 runner 映像（用於 CI/CD）
docker build -t db-migrate:2.0.0-runner --target runner .
```

### Docker Compose 使用

```bash
# 啟動完整環境（MongoDB + MariaDB）
docker compose up -d

# 查看服務狀態
docker compose ps

# 執行 MongoDB 遷移
docker compose run --rm runner-mongodb up

# 執行 MariaDB 遷移
docker compose run --rm runner-mariadb up

# 查看狀態
docker compose run --rm runner-mongodb status

# 執行測試
docker compose run --rm runner-mongodb test

# 執行所有測試並生成報表
docker compose run --rm test-all

# 停止所有服務
docker compose down

# 清理資料
docker compose down -v
```

---

## ☸️ Kubernetes 部署

### 安裝開發環境

```bash
# 安裝 minikube, kubectl, helm, k9s
./scripts/setup-k8s-dev.sh

# 啟動 minikube
minikube start

# 使用 k9s 管理
k9s
```

### Helm Chart 使用

詳細的 Helm values 設定請參考 [charts/db-migrate/values.yaml](charts/db-migrate/values.yaml)

#### MongoDB 部署

```bash
# 基本部署
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=true \
  --set mongodb.host=mongodb.default.svc.cluster.local \
  --set mongodb.database=myapp

# 帶認證
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=true \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set mongodb.auth.enabled=true \
  --set mongodb.auth.username=admin \
  --set mongodb.auth.existingSecret=my-mongodb-secret

# Replica Set
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=true \
  --set mongodb.host=mongodb-0.mongodb-headless \
  --set mongodb.database=myapp \
  --set mongodb.options.replicaSet=rs0
```

#### MariaDB 部署

```bash
# 基本部署（密碼必須使用 Secret）
# Step 1: 建立 Secret
kubectl create secret generic my-mariadb-secret \
  --from-literal=mariadb-password=<your-password>

# Step 2: 部署
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=false \
  --set mariadb.enabled=true \
  --set mariadb.host=mariadb.default.svc.cluster.local \
  --set mariadb.database=myapp \
  --set mariadb.user=migrate \
  --set mariadb.existingSecret=my-mariadb-secret
```

#### 啟用 Sanity Check

```bash
# 啟用 Sanity Check (Pre-Check / Post-Check / Auto-Rollback)
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=true \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=up \
  --set migration.sanityCheck.enabled=true \
  --set migration.sanityCheck.autoRollback=true \
  --set migration.sanityCheck.timeoutMs=30000

# 啟用 Sanity Check 但停用 Auto-Rollback
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=true \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=up \
  --set migration.sanityCheck.enabled=true \
  --set migration.sanityCheck.autoRollback=false
```

#### 執行不同指令

```bash
# 查看狀態
helm upgrade --install migration-status ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=status

# 執行遷移
helm upgrade --install migration-up ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=up

# 執行遷移 (帶 Sanity Check)
helm upgrade --install migration-up ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=up \
  --set migration.sanityCheck.enabled=true

# 回滾
helm upgrade --install migration-down ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=down \
  --set migration.downCount=1

# 驗證
helm upgrade --install migration-validate ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set migration.command=validate
```

#### 使用 ConfigMap 載入遷移（單一 DB 模式）

```bash
# 建立 ConfigMap
kubectl create configmap my-migrations \
  --from-file=./databases/myapp/migrations/

# 部署
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.host=mongodb \
  --set mongodb.database=myapp \
  --set customMigrations.enabled=true \
  --set customMigrations.configMapName=my-migrations
```

#### 多資料庫 ConfigMap 模式（推薦）

適合同時管理多個資料庫（如 ecommerce、analytics、logging），每個 DB 一個 ConfigMap，DDL+DCL 合併管理。

**執行順序：**
1. ConfigMap 建立 (hook-weight: `-10`)
2. DDL Jobs 執行 (hook-weight: `-3`) — 先建 table 結構
3. DCL Jobs 執行 (hook-weight: `-1`) — 再設定帳號權限

```bash
# Step 1: 為每個 DB 建立密碼 Secret
kubectl create secret generic ecommerce-ddl-secret \
  --from-literal=mariadb-password=<ecommerce-ddl-password>
kubectl create secret generic analytics-ddl-secret \
  --from-literal=mariadb-password=<analytics-ddl-password>
kubectl create secret generic logging-ddl-secret \
  --from-literal=mariadb-password=<logging-ddl-password>
kubectl create secret generic dcl-root-secret \
  --from-literal=mariadb-password=<root-password>

# Step 2: 使用 values 檔案部署
helm upgrade --install db-migration ./charts/db-migrate \
  -f charts/db-migrate/values-multi-db.yaml
```

`values-multi-db.yaml` 結構：
```yaml
migrations:
  enabled: true
  databases:
    - name: ecommerce
      type: mariadb
      host: mariadb.production.svc.cluster.local
      port: 3306
      ddl:
        user: ecommerce_ddl_admin
        existingSecret: ecommerce-ddl-secret
        sanityCheck: { enabled: true, autoRollback: true, timeoutMs: 30000 }
        files:
          20260101000001-create-users.sql: |
            -- +migrate Up
            CREATE TABLE IF NOT EXISTS users ( ... );
            -- +migrate Down
            DROP TABLE IF EXISTS users;
      dcl:
        user: root
        existingSecret: dcl-root-secret
        files:
          R__01_ecommerce_users.sql: |
            CREATE USER IF NOT EXISTS ...;
```

> 完整範例見 [charts/db-migrate/values-multi-db.yaml](charts/db-migrate/values-multi-db.yaml)

#### 使用 gen-values.py 自動產生 values

從本地專案目錄掃描 DDL/DCL 遷移檔案，自動產生 Helm `values.yaml`：

```bash
# 查看掃描結果（不產生 YAML）
python3 scripts/gen-values.py databases/mariadb/production-server --dry-run

# 產生 values.yaml 到 stdout
python3 scripts/gen-values.py databases/mariadb/production-server \
  --host mariadb.prod.svc.cluster.local

# 產生到檔案
python3 scripts/gen-values.py databases/mariadb/production-server \
  --host mariadb.prod.svc.cluster.local \
  -o charts/db-migrate/values-production.yaml

# 搭配 helm 部署
python3 scripts/gen-values.py databases/mariadb/production-server \
  --host mariadb.prod.svc.cluster.local \
  --image-tag 2.1.0 \
  -o /tmp/values.yaml \
  && helm upgrade --install db-migration ./charts/db-migrate -f /tmp/values.yaml
```

---

## 📊 報表

測試執行後會生成報表：

- **JSON**: `reports/migration-report-YYYYMMDD-HHMMSS.json`
- **HTML**: `reports/migration-report-YYYYMMDD-HHMMSS.html`

HTML 報表包含：
- 總覽統計卡片
- 詳細測試結果表格
- 成功/失敗視覺化標示
- 執行時間統計

生成報表：
```bash
# 指定輸出目錄
node src/cli.js test-all -o ./my-reports

# 多實例測試報表
node src/cli.js -c databases/mongodb/multi-instance/config.js test-instances -o ./reports
```

---

## 🔗 相關文件

- [CLI 使用指南](docs/CLI-USAGE-GUIDE.md)
- [遷移管理指南](docs/MIGRATION-MANAGEMENT-GUIDE.md)
- [AWS 風格發布公告](docs/MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md)
- [驗證規則參考](docs/VALIDATION-RULES-REFERENCE.md)
- [MariaDB 使用指南](docs/USER-GUIDE-MARIADB.md)
- [MongoDB 使用指南](docs/USER-GUIDE-MONGODB.md)
- [既有資料庫導入指南](docs/EXISTING-DATABASE-ONBOARDING.md)
- [本地測試指南](docs/LOCAL-TEST-GUIDE.md)
- [Docker Compose 使用指南](docs/DOCKER-COMPOSE-USER-GUIDE.md)
- [CI 遷移測試指南](docs/CI-MIGRATION-TEST-GUIDE.md)
- [建置映像指南](docs/BUILD-IMAGE-GUIDE.md)
- [Vault / Boundary 整合](docs/VAULT-BOUNDARY-GUIDE.md)
- [Helm Chart Values 說明](charts/db-migrate/values.yaml)

---

## 📝 License

MIT License
