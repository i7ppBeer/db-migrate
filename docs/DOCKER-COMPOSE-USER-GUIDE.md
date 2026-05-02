# Docker Compose 使用者操作指南

> 本指南從使用者角度出發，說明如何使用 docker-compose 執行所有 CLI 操作。

---

## 目錄

1. [環境準備](#1-環境準備)
2. [DCL (資料控制語言) - 帳號權限管理](#2-dcl-資料控制語言---帳號權限管理)
   - [第一次建立帳號](#21-第一次建立帳號)
   - [修改權限或新增帳號](#22-修改權限或新增帳號)
   - [驗證 DCL 腳本](#23-驗證-dcl-腳本)
3. [DDL (資料定義語言) - 結構變更管理](#3-ddl-資料定義語言---結構變更管理)
   - [第一次建立 DDL Migration](#31-第一次建立-ddl-migration)
   - [撰寫 Up + PostCheck + Down](#32-撰寫-up--postcheck--down)
   - [驗證 DDL 腳本](#33-驗證-ddl-腳本)
4. [實際連線測試 (DCL + DDL Up/Down/Up)](#4-實際連線測試-dcl--ddl-updownup)
5. [完整範例流程](#5-完整範例流程)
6. [常用指令速查表](#6-常用指令速查表)

---

## 1. 環境準備

### 啟動資料庫服務

```bash
# 啟動 MariaDB 和 MongoDB 資料庫
docker compose up -d mariadb mongodb

# 確認服務已啟動且健康
docker compose ps
```

### 建立 Migration Runner 服務 (docker-compose.user.yml)

在專案根目錄建立以下檔案，方便後續操作：

```yaml
# docker-compose.user.yml - 使用者操作用
version: "3.8"

services:
  # Migration CLI 工具
  migrate:
    build:
      context: .
      dockerfile: Dockerfile
      target: runner
    working_dir: /app
    volumes:
      # 掛載你的 migration 目錄
      - ./databases:/app/databases:ro
      - ./reports:/app/reports
    environment:
      - MARIADB_HOST=mariadb
      - MARIADB_PORT=3306
      - MARIADB_USER=root
      - MARIADB_PASSWORD=rootpass
      - MONGODB_HOST=mongodb
      - MONGODB_PORT=27017
    networks:
      - migrate-network
    profiles:
      - tools

networks:
  migrate-network:
    external: true
    name: mongodb-migrate_migrate-network
```

---

## 2. DCL (資料控制語言) - 帳號權限管理

DCL 使用 **Repeatable** 模式，檔案以 `R__` 開頭，每當內容 (checksum) 改變就會重新執行。

### 2.1 第一次建立帳號

#### Step 1: 複製範本或建立 DCL 目錄結構

```bash
# 方式一：複製範本 (推薦)
cp -r test-fixtures/mariadb/_templates/dcl test-fixtures/mariadb/my-project/dcl

# 方式二：手動建立目錄
mkdir -p test-fixtures/mariadb/my-project/dcl/migrations
```

#### Step 2: 建立 Config 檔案 (如使用範本可跳過)

```bash
cat > test-fixtures/mariadb/my-project/dcl/config.js << 'EOF'
/**
 * DCL Configuration - 帳號權限管理
 */
export default {
  type: 'mariadb',
  host: process.env.MARIADB_HOST || 'localhost',
  port: parseInt(process.env.MARIADB_PORT || '3306'),
  user: process.env.MARIADB_USER || 'root',
  password: process.env.MARIADB_PASSWORD || 'rootpass',
  database: 'mysql',  // DCL 操作在 mysql 系統資料庫
  
  migrationsDir: './migrations',
  checksumTable: 'dcl_repeatable_migrations',
  mode: 'repeatable',
  
  idempotencyCheck: {
    enabled: true,
    verbose: true
  }
};
EOF
```

#### Step 3: 建立公版 Default 帳號腳本

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__00_default_users.sql << 'EOF'
-- R__00_default_users.sql
-- DCL Repeatable Migration: Default Service Account (公版)
-- ⚠️ 必須是 IDEMPOTENT (可重複執行)

-- ============================================
-- Default Service Account
-- 用於基本服務連線，第一次登入需自行修改密碼
-- ============================================

-- 清除後重建，確保冪等性
DROP USER IF EXISTS 'app_default'@'%';
CREATE USER 'app_default'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次登入強制改密碼

-- 基本 SELECT 權限 (可依需求調整)
GRANT SELECT ON mydb.* TO 'app_default'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 4: 建立 Readonly 帳號腳本

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__01_readonly_users.sql << 'EOF'
-- R__01_readonly_users.sql
-- DCL Repeatable Migration: Read-Only Users
-- ⚠️ 必須是 IDEMPOTENT (可重複執行)

-- ============================================
-- Read-Only User (報表、查詢用)
-- ============================================

DROP USER IF EXISTS 'app_readonly'@'%';
CREATE USER 'app_readonly'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次登入強制改密碼

-- 只給 SELECT 權限
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';

-- 可視需求給予其他資料庫的唯讀權限
-- GRANT SELECT ON analytics.* TO 'app_readonly'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 5: 建立 Readwrite 帳號腳本

```bash
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__02_readwrite_users.sql << 'EOF'
-- R__02_readwrite_users.sql
-- DCL Repeatable Migration: Read-Write Users (Application Accounts)
-- ⚠️ 必須是 IDEMPOTENT (可重複執行)

-- ============================================
-- Application User (CRUD 操作)
-- ============================================

DROP USER IF EXISTS 'app_readwrite'@'%';
CREATE USER 'app_readwrite'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;  -- 第一次登入強制改密碼

-- SELECT, INSERT, UPDATE, DELETE 權限
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite'@'%';

FLUSH PRIVILEGES;
EOF
```

#### Step 6: 執行 DCL Migration

```bash
# 使用 docker-compose 執行 DCL
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 或使用簡化別名 (需先設定)
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

### 2.2 修改權限或新增帳號

DCL 是 **Repeatable** 模式，只需要修改對應的 SQL 檔案，然後重新執行即可。

#### 新增帳號

```bash
# 新增一個 DDL Admin 帳號
cat > test-fixtures/mariadb/my-project/dcl/migrations/R__03_ddl_admin.sql << 'EOF'
-- R__03_ddl_admin.sql
-- DCL Repeatable Migration: DDL Admin User
-- ⚠️ 必須是 IDEMPOTENT (可重複執行)

-- ============================================
-- DDL Admin (Schema 管理員)
-- ============================================

DROP USER IF EXISTS 'app_ddl_admin'@'%';
CREATE USER 'app_ddl_admin'@'%' 
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN'
  PASSWORD EXPIRE;

-- DDL 權限: CREATE, ALTER, DROP, INDEX, etc.
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_ddl_admin'@'%';
GRANT CREATE, ALTER, DROP, INDEX, REFERENCES ON mydb.* TO 'app_ddl_admin'@'%';

FLUSH PRIVILEGES;
EOF
```

#### 修改權限

```bash
# 直接編輯對應的 SQL 檔案
# 例如: 給 readonly 帳號增加 analytics 資料庫的存取權

# 編輯 R__01_readonly_users.sql，加入:
# GRANT SELECT ON analytics.* TO 'app_readonly'@'%';
```

#### 重新執行 DCL

```bash
# DCL 會自動偵測 checksum 變化，只執行有修改的檔案
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

#### 查看 DCL 狀態

```bash
# 查看哪些 DCL 需要更新
docker compose run --rm migrate \
  node src/cli.js dcl:status \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

### 2.3 驗證 DCL 腳本

#### 驗證冪等性 (Idempotent)

```bash
# 驗證所有 DCL 腳本是否為冪等 (可重複執行)
docker compose run --rm migrate \
  node src/cli.js dcl:verify \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

**預期輸出:**

```
[DCL VERIFY] Testing idempotency (mariadb)...
══════════════════════════════════════════════════

📄 R__00_default_users.sql
   ✅ IDEMPOTENT

📄 R__01_readonly_users.sql
   ✅ IDEMPOTENT

📄 R__02_readwrite_users.sql
   ✅ IDEMPOTENT

══════════════════════════════════════════════════

✅ All DCL scripts are idempotent!
```

#### Dry Run 預覽

```bash
# 預覽會執行哪些 DCL
docker compose run --rm migrate \
  node src/cli.js dcl --dry-run \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

## 3. DDL (資料定義語言) - 結構變更管理

DDL 使用 **Versioned** 模式，檔案以時間戳開頭 (如 `20250101000001-`），依序執行且只執行一次。

### 3.1 第一次建立 DDL Migration

#### Step 1: 複製範本或建立 DDL 目錄結構

```bash
# 方式一：複製範本 (推薦)
cp -r test-fixtures/mariadb/_templates/ddl test-fixtures/mariadb/my-project/ddl

# 方式二：手動建立目錄
mkdir -p test-fixtures/mariadb/my-project/ddl/migrations
```

#### Step 2: 建立 Config 檔案 (如使用範本可跳過)

```bash
cat > test-fixtures/mariadb/my-project/ddl/config.js << 'EOF'
/**
 * DDL Configuration - 結構變更管理
 */
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'mydb',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'rootpass'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations',
  
  // 啟用 Sanity Check
  sanityCheck: {
    enabled: true,
    autoRollback: true,
    verbose: true
  }
};
EOF
```

#### Step 3: 使用 CLI 建立 Migration 檔案

```bash
# 建立新的 DDL migration
docker compose run --rm migrate \
  node src/cli.js create create-users \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**輸出:**
```
✅ Created: 20260121123456-create-users.sql

Remember to:
1. Implement the UP section
2. Implement the DOWN section
3. Run validation: db-migrate validate -c <config>
```

---

### 3.2 撰寫 Up + PostCheck + Down

#### 完整範例: 建立 Users 資料表

```sql
-- 20260121123456-create-users.sql
-- Migration: Create users table

-- +sanity PreCheck
-- 驗證 users 資料表尚未存在
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- END_CHECK

-- +migrate Up
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(100),
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive', 'pending', 'suspended') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY idx_users_email (email),
    KEY idx_users_status (status),
    KEY idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 驗證 users 資料表已建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='email'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_email'
-- END_CHECK

-- +migrate Down
DROP TABLE IF EXISTS users;
```

#### 範例: 新增欄位

```sql
-- 20260121130000-add-phone-column.sql
-- Migration: Add phone column to users table

-- +sanity PreCheck
-- 驗證 users 存在且 phone 欄位尚未存在
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- END_CHECK

-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL COMMENT 'User phone number';
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE;
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- 驗證欄位和索引已建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone_verified'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_phone'
-- END_CHECK

-- +migrate Down
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone_verified;
ALTER TABLE users DROP COLUMN phone;
```

### Sanity Check 語法說明

| 語法 | 說明 |
|------|------|
| `-- +sanity PreCheck` | 開始 PreCheck 區塊 |
| `-- +sanity PostCheck` | 開始 PostCheck 區塊 |
| `-- EXPECT_ROWS: <SQL>` | 預期查詢應有結果 (至少 1 row) |
| `-- EXPECT_NO_ROWS: <SQL>` | 預期查詢應無結果 (0 rows) |
| `-- END_CHECK` | 結束 Check 區塊 |

---

### 3.3 驗證 DDL 腳本

#### 基本驗證

```bash
# 驗證所有 DDL migration 檔案
docker compose run --rm migrate \
  node src/cli.js validate \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**預期輸出:**
```
[VALIDATE] Checking migrations (mariadb)...

[OK] 20260121123456-create-users.sql
[OK] 20260121130000-add-phone-column.sql

──────────────────────────────────────────────────
Total: 2 file(s)
Valid: 2
Invalid: 0

✅ All migrations are valid!
```

#### 允許危險操作 (需要時)

```bash
# 允許危險操作 (如 DROP TABLE)
docker compose run --rm migrate \
  node src/cli.js validate --allow-dangerous \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 允許特定操作碼
docker compose run --rm migrate \
  node src/cli.js validate --allow DROP_TABLE,TRUNCATE \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

#### 查看 Migration 狀態

```bash
# 查看已執行和待執行的 migration
docker compose run --rm migrate \
  node src/cli.js status \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 4. 實際連線測試 (DCL + DDL Up/Down/Up)

### 4.1 啟動測試資料庫

```bash
# 確保資料庫已啟動
docker compose up -d mariadb

# 等待資料庫就緒
docker compose exec mariadb mariadb-admin ping -h localhost -u root -prootpass --wait=30
```

### 4.2 建立測試資料庫

```bash
# 建立測試用資料庫
docker compose exec mariadb mariadb -u root -prootpass -e "CREATE DATABASE IF NOT EXISTS mydb;"
```

### 4.3 執行 DCL (建立帳號)

```bash
# 第一步: 執行 DCL 建立所有帳號
docker compose run --rm migrate \
  node src/cli.js dcl \
  -c /app/test-fixtures/mariadb/my-project/dcl/config.js

echo "✅ DCL 執行完成"
```

### 4.4 執行 DDL Up

```bash
# 執行所有待執行的 DDL migration
docker compose run --rm migrate \
  node src/cli.js up \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Up 執行完成"
```

### 4.5 執行 DDL Down

```bash
# Rollback 最近 1 個 migration
docker compose run --rm migrate \
  node src/cli.js down -n 1 \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Down 執行完成"
```

### 4.6 再次執行 DDL Up

```bash
# 再次執行 Up，驗證可重複執行
docker compose run --rm migrate \
  node src/cli.js up \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js

echo "✅ DDL Up 再次執行完成"
```

### 4.7 使用內建 Up-Down-Up 測試

```bash
# 一鍵執行 Up-Down-Up 測試
docker compose run --rm migrate \
  node src/cli.js test \
  -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

**預期輸出:**
```
🧪 Running Up-Down-Up Test (mariadb)...

══════════════════════════════════════════════════

[UP] Running migrations...
   ✅ Applied: 20260121123456-create-users.sql
   ✅ Applied: 20260121130000-add-phone-column.sql

[DOWN] Rolling back all migrations...
   ⏪ Rolled back: 20260121130000-add-phone-column.sql
   ⏪ Rolled back: 20260121123456-create-users.sql

[UP] Running migrations again...
   ✅ Applied: 20260121123456-create-users.sql
   ✅ Applied: 20260121130000-add-phone-column.sql

══════════════════════════════════════════════════

✅ Up-Down-Up Test PASSED!
   Duration: 2.35s
```

---

## 5. 完整範例流程

### 一鍵執行完整流程腳本

```bash
#!/bin/bash
# full-migration-test.sh

set -e  # 遇到錯誤就停止

PROJECT_PATH="test-fixtures/mariadb/my-project"
DCL_CONFIG="/app/${PROJECT_PATH}/dcl/config.js"
DDL_CONFIG="/app/${PROJECT_PATH}/ddl/config.js"

echo "=========================================="
echo "  Migration 完整測試流程"
echo "=========================================="

# 1. 啟動資料庫
echo ""
echo "📦 Step 1: 啟動資料庫..."
docker compose up -d mariadb
sleep 5

# 2. 建立測試資料庫
echo ""
echo "📦 Step 2: 建立測試資料庫..."
docker compose exec mariadb mariadb -u root -prootpass -e "CREATE DATABASE IF NOT EXISTS mydb;"

# 3. 驗證 DCL 腳本
echo ""
echo "📋 Step 3: 驗證 DCL 腳本..."
docker compose run --rm migrate node src/cli.js dcl:verify -c $DCL_CONFIG

# 4. 執行 DCL
echo ""
echo "🔐 Step 4: 執行 DCL (建立帳號)..."
docker compose run --rm migrate node src/cli.js dcl -c $DCL_CONFIG

# 5. 驗證 DDL 腳本
echo ""
echo "📋 Step 5: 驗證 DDL 腳本..."
docker compose run --rm migrate node src/cli.js validate -c $DDL_CONFIG

# 6. 執行 DDL Up-Down-Up 測試
echo ""
echo "🧪 Step 6: 執行 DDL Up-Down-Up 測試..."
docker compose run --rm migrate node src/cli.js test -c $DDL_CONFIG

# 7. 顯示最終狀態
echo ""
echo "📊 Step 7: 顯示最終狀態..."
docker compose run --rm migrate node src/cli.js status -c $DDL_CONFIG
docker compose run --rm migrate node src/cli.js dcl:status -c $DCL_CONFIG

echo ""
echo "=========================================="
echo "  ✅ 所有測試通過！"
echo "=========================================="
```

### 執行腳本

```bash
chmod +x full-migration-test.sh
./full-migration-test.sh
```

---

## 6. 常用指令速查表

### DCL (Repeatable) 指令

| 操作 | 指令 |
|------|------|
| 建立 DCL 檔案 | `node src/cli.js create-dcl <name> -c <config>` |
| 執行 DCL | `node src/cli.js dcl -c <config>` |
| 查看 DCL 狀態 | `node src/cli.js dcl:status -c <config>` |
| 驗證冪等性 | `node src/cli.js dcl:verify -c <config>` |
| 預覽 (Dry Run) | `node src/cli.js dcl --dry-run -c <config>` |

### DDL (Versioned) 指令

| 操作 | 指令 |
|------|------|
| 建立 Migration | `node src/cli.js create <name> -c <config>` |
| 執行 Up | `node src/cli.js up -c <config>` |
| 執行 Down | `node src/cli.js down -n <count> -c <config>` |
| 帶 Sanity Check 的 Up | `node src/cli.js up --sanity-check -c <config>` |
| 查看狀態 | `node src/cli.js status -c <config>` |
| 驗證 Migration | `node src/cli.js validate -c <config>` |
| Up-Down-Up 測試 | `node src/cli.js test -c <config>` |
| 預覽 (Dry Run) | `node src/cli.js up --dry-run -c <config>` |

### Docker Compose 快捷指令

```bash
# 定義 alias 方便使用
alias migrate='docker compose run --rm migrate node src/cli.js'

# 然後就可以這樣用:
migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 附錄: 密碼管理最佳實踐

### 使用環境變數 (推薦用於生產環境)

```sql
-- 不要在 SQL 中硬編碼密碼
-- 改用 placeholder 或環境變數

-- 範例: 使用 shell 預處理
-- 在執行前用 envsubst 替換

DROP USER IF EXISTS 'app_readonly'@'%';
CREATE USER 'app_readonly'@'%' 
  IDENTIFIED BY '${DB_READONLY_PASSWORD}'
  PASSWORD EXPIRE;
```

### 使用 Secret Manager

```bash
# 從 Secret Manager 取得密碼後設定環境變數
export DB_READONLY_PASSWORD=$(az keyvault secret show --name db-readonly-pass --vault-name myvault --query value -o tsv)

# 然後執行 migration
docker compose run --rm \
  -e DB_READONLY_PASSWORD="$DB_READONLY_PASSWORD" \
  migrate node src/cli.js dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

---

## 問題排解

### Q: DCL 執行失敗，顯示 "not idempotent"

**A:** 確保你的 DCL 腳本使用 `DROP USER IF EXISTS` + `CREATE USER` 模式，而不是只用 `CREATE USER`。

### Q: DDL Down 失敗

**A:** 
1. 確認 `-- +migrate Down` 區塊有正確的 rollback 語句
2. 確認順序正確 (先 drop index，再 drop column)

### Q: PostCheck 失敗

**A:** 
1. 檢查 SQL 語法是否正確
2. 確認 `DATABASE()` 函數返回正確的資料庫名稱
3. 使用 `docker compose exec mariadb mariadb -u root -prootpass -e "SELECT DATABASE();"` 確認

---

**最後更新:** 2026-01-21
