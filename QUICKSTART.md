# Quick Start - Docker Compose 操作指南

> 使用者快速上手指南

## 🚀 快速開始

### 1. 啟動資料庫

```bash
docker compose up -d mariadb mongodb
```

### 2. 使用 Migration CLI

```bash
# 基本格式
docker compose run --rm migrate <command> -c <config-path>

# 範例: 查看狀態
docker compose run --rm migrate status -c /app/test-fixtures/mariadb/test-success/ddl/config.js
```

---

## �� DCL (帳號權限管理) - Repeatable 模式

### 建立帳號 (使用現有測試案例)

```bash
# 1. 建立新 DCL 遷移
docker compose run --rm migrate create-dcl readonly_users -c /app/test-fixtures/mariadb/production-server/dcl/config.js

# 2. 修改 config.js — 只需填寫與預設值不同的欄位 (delta)
#    export default {
#      type: 'mariadb',
#      mode: 'repeatable',
#      database: 'mysql',
#      checksumTable: '_dcl_migrations',
#    };

# 3. 修改 migrations/*.sql 中的帳號和權限

# 4. 驗證冪等性
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 5. 執行
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

### 修改權限或新增帳號

```bash
# 直接編輯 SQL 檔案，然後重新執行
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

### DCL 指令速查

| 指令 | 說明 |
|------|------|
| `dcl` | 執行 DCL migrations |
| `dcl --dry-run` | 預覽要執行的 DCL |
| `dcl:status` | 查看 DCL 狀態 |
| `dcl:verify` | 驗證 DCL 冪等性 |
| `create-dcl <name>` | 建立新 DCL 檔案 |

---

## 📊 DDL (結構變更) - Versioned 模式

### 建立 Migration

```bash
# 1. 建立新 migration
docker compose run --rm migrate create create-users -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 2. 修改 config.js — 只需填寫 delta
#    export default {
#      type: 'mariadb',
#      database: process.env.MARIADB_DB || 'myapp',
#    };

# 3. 編輯產生的 SQL 檔案 (加入 Up + PostCheck + Down)

# 4. 驗證
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. 執行
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

### DDL 指令速查

| 指令 | 說明 |
|------|------|
| `up` | 執行待處理的 migrations |
| `up --sanity-check` | 執行並做 sanity check |
| `up --dry-run` | 預覽要執行的 migrations |
| `down -n 1` | Rollback 最近 1 個 migration |
| `status` | 查看 migration 狀態 |
| `validate` | 驗證 migration 檔案 |
| `test` | 執行 Up-Down-Up 測試 |
| `create <name>` | 建立新 migration |

---

## 🧪 完整測試流程

### 一鍵測試

```bash
./scripts/full-migration-test.sh test-success mariadb
```

### 手動測試流程

```bash
# 1. 啟動 DB
docker compose up -d mariadb

# 2. DCL - 建立帳號
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 3. DDL - 驗證
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 4. DDL - Up
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. DDL - Down
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 6. DDL - Up again
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 🍃 MongoDB 操作指南

### DCL (帳號權限管理)

```bash
# 1. 建立新 DCL 遷移
docker compose run --rm migrate create-dcl my_users -c /app/test-fixtures/mongodb/my-project/dcl/config.js

# 2. 修改 config.js — 只需填寫 delta
#    export default {
#      type: 'mongodb',
#      mode: 'repeatable',
#      mongodb: { databaseName: 'admin' },
#    };

# 3. 驗證冪等性
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mongodb/my-project/dcl/config.js

# 4. 執行
docker compose run --rm migrate dcl -c /app/test-fixtures/mongodb/my-project/dcl/config.js
```

### DDL (結構變更)

```bash
# 1. 建立新 migration
docker compose run --rm migrate create create-users -c /app/test-fixtures/mongodb/my-project/ddl/config.js

# 2. 修改 config.js — 只需填寫 delta
#    export default {
#      type: 'mongodb',
#      mongodb: { databaseName: process.env.MONGO_DB || 'myapp' },
#    };

# 3. 執行
docker compose run --rm migrate up -c /app/test-fixtures/mongodb/my-project/ddl/config.js

# 4. Up-Down-Up 測試
docker compose run --rm migrate test -c /app/test-fixtures/mongodb/my-project/ddl/config.js
```

### MongoDB 內建角色參考

| 角色 | 權限 |
|------|------|
| `read` | 唯讀 (find, listCollections) |
| `readWrite` | 讀寫 (CRUD 操作) |
| `dbAdmin` | 資料庫管理 (索引、統計、驗證) |
| `dbOwner` | 完整權限 (readWrite + dbAdmin + userAdmin) |
| `userAdmin` | 使用者管理 |

---

## 📖 完整文件

詳細說明請參考: [docs/DOCKER-USAGE.md](./docs/DOCKER-USAGE.md)
