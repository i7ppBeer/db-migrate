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
  - **智能允許**: CREATE DATABASE 允許在 UP，DROP DATABASE 允許在 DOWN（當 UP 有創建時）
  - **批量驗證**: `validate-all` 命令一次驗證整個目錄的 DDL + DCL
- **資料庫自動創建**: MariaDB adapter 會在連接前自動創建資料庫（雙重保障）
- **Up-Down-Up 測試**: 確保遷移可以正確回滾和重新應用
- **DCL 冪等性驗證**: 自動驗證 DCL 腳本執行多次結果相同
- **DCL 自動生成密碼**: 每個 `CHANGE_ME_ON_FIRST_LOGIN` 佔位符在執行時各自替換為獨立的高強度 16 字元密碼——原始檔案永不修改；憑證僅寫入 `/tmp/secret`，不顯示於 console。MongoDB 新帳號還會自動注入含有效期的 `customData`。
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

### 📦 Docker Compose 方式（推薦，無需本機 Node.js）

> 透過 Docker Container 執行所有 CLI 指令，無需本機安裝 Node.js。

#### 環境設定

```bash
# 啟動資料庫
docker compose up -d mongodb mariadb

# 首次使用需 build migrate 服務
docker compose build migrate
```

**指令格式**：
```bash
docker compose run --rm migrate <command> [options] -c /app/databases/<db-type>/<project>/config.js
```

> **📝 關於範例說明**：  
> 本文檔實際可用的目錄名稱：
> - `production-server` - 多資料庫範例（包含 analytics, ecommerce, logging）
> - `test-success` - 成功測試範例
> - `test-failure` - 失敗測試範例（驗證用）
> - `multi-instance` - 多實例範例
> 
> 所有範例皆可直接複製執行，無需替換任何占位符！

---

#### 基礎指令

**查看狀態** (`status`):
```bash
docker compose run --rm migrate status -c /app/databases/mariadb/test-success/ddl/config.js
```

**執行遷移** (`up`):
```bash
# 執行所有待處理遷移
docker compose run --rm migrate up -c /app/databases/mariadb/test-success/ddl/config.js

# Dry Run 預覽
docker compose run --rm migrate up --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# 啟用 Sanity Check
docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/test-success/ddl/config.js
```

**回滾遷移** (`down`):
```bash
# 回滾最後 1 筆
docker compose run --rm migrate down -n 1 -c /app/databases/mariadb/test-success/ddl/config.js

# 回滾最後 3 筆
docker compose run --rm migrate down -n 3 -c /app/databases/mariadb/test-success/ddl/config.js
```

**建立遷移檔** (`create` / `create-dcl`):
```bash
# 建立 DDL 遷移
docker compose run --rm migrate create add-orders-table -c /app/databases/mariadb/test-success/ddl/config.js

# 建立 DCL 遷移
docker compose run --rm migrate create-dcl readonly_users -c /app/databases/mariadb/production-server/dcl/config.js

# 指定流水號
docker compose run --rm migrate create-dcl app_service -n 004 -c /app/databases/mariadb/production-server/dcl/config.js
```

**驗證遷移** (`validate`):
```bash
# 嚴格驗證
docker compose run --rm migrate validate -c /app/databases/mariadb/test-success/ddl/config.js

# 放行危險操作
docker compose run --rm migrate validate --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js

# 放行特定操作
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/databases/mariadb/test-success/ddl/config.js
```

**批量驗證** (`validate-all`):
```bash
# 驗證整個目錄的 DDL + DCL
docker compose run --rm migrate validate-all /app/databases/mariadb/production-server

# 只驗證 DDL（不需資料庫連線）
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/production-server

# 只驗證 DCL（需資料庫連線）
docker compose run --rm migrate validate-all --dcl-only /app/databases/mariadb/production-server
```

**標記既有遷移** (`baseline`):
```bash
# 標記全部（Dry Run）
docker compose run --rm migrate baseline --all --dry-run -c /app/databases/mariadb/test-success/ddl/config.js

# 正式標記
docker compose run --rm migrate baseline --all -c /app/databases/mariadb/test-success/ddl/config.js

# 標記到指定版本
docker compose run --rm migrate baseline --up-to 20250101000003-create-products.sql -c /app/databases/mariadb/test-success/ddl/config.js
```

**Up-Down-Up 測試** (`test`):
```bash
docker compose run --rm migrate test -c /app/databases/mariadb/test-success/ddl/config.js
```

---

#### DCL 指令

**執行 DCL 遷移** (`dcl`):
```bash
docker compose run --rm migrate dcl -c /app/databases/mariadb/production-server/dcl/config.js

# Dry Run
docker compose run --rm migrate dcl --dry-run -c /app/databases/mariadb/production-server/dcl/config.js
```

**查看 DCL 狀態** (`dcl:status`):
```bash
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/production-server/dcl/config.js
```

**驗證 DCL 冪等性** (`dcl:verify`):
```bash
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/production-server/dcl/config.js
```

---

#### DCL 自動生成密碼

DCL 範本檔案（`R__*.sql` / `R__*.js`）可使用 `CHANGE_ME_ON_FIRST_LOGIN` 作為密碼佔位符。
Runner 執行時會**自動為每個佔位符獨立生成一組高強度密碼**——同一檔案中的多個帳號各自得到不同密碼。

**運作方式：**

| | 說明 |
|---|---|
| 磁碟上的檔案 | 永遠不變，仍保留 `CHANGE_ME_ON_FIRST_LOGIN` |
| Checksum | 從原始檔案計算（密碼輪換**不會**觸發重新執行） |
| 替換時機 | 僅在記憶體中，SQL/JS 送到資料庫前的瞬間 |
| 每個佔位符 | 各自獨立生成密碼（occurrence 0 → 帳號 0，occurrence 1 → 帳號 1…） |
| Console 顯示 | **不顯示密碼**，只印出簡短提示 |
| 磁碟記錄 | 追加至 `/tmp/secret`（格式：`username=password`，一行一筆） |

**密碼規則：** 16 字元 · a-z · A-Z · 0-9 · 1-2 個特殊字元（`-` 或 `~`）  
特殊字元在 MySQL/MariaDB CLI、`mongosh`、MongoDB URI、Bash、ProxySQL 均安全使用。

**`/tmp/secret` 格式**（依宣告順序對應帳號）：
```
app_readonly=6U3uELfN6alX0~CJ
app_readwrite=9kP2mQrX7sZa1-NW
```

> `/tmp/secret` 為 append-only，請依照安全政策自行管理或輪換。  
> Kubernetes / Docker 環境請掛載安全 volume 到 `/tmp`，或在 Pod 結束前將 `/tmp/secret` 複製出來。

**執行 `dcl` 的 console 輸出範例：**

```
[DCL] Auto-generated password for: R__004_secret_users.sql
  📝 [DCL] Credentials saved to /tmp/secret: app_readonly, app_readwrite
```

**帳號已存在時自動略過**（MariaDB 偵測 `SHOW WARNINGS` Note 1973 / MongoDB `return { passwordSet: false }`）：
```
[DCL] Auto-generated password for: R__004_secret_users.sql
  ⚠️  [DCL] Account already existed — password NOT changed. Skipped /tmp/secret: app_readonly, app_readwrite
```

| 情境 | `/tmp/secret` | Console |
|---|---|---|
| 新帳號 | **寫入** | `📝 Credentials saved` |
| 帳號已存在（`CREATE USER IF NOT EXISTS`） | **不寫入** | `⚠️ Account already existed — Skipped` |
| 強制輪換（`ALTER USER`） | **永遠寫入** | `📝 Credentials saved` |

**MariaDB — 多帳號，各自獨立密碼**（`R__004_secret_users.sql`）：
```sql
-- 每個 CHANGE_ME_ON_FIRST_LOGIN 在執行時替換為不同密碼
CREATE USER IF NOT EXISTS 'app_readonly'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
CREATE USER IF NOT EXISTS 'app_readwrite'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON mydb.* TO 'app_readwrite'@'%';
FLUSH PRIVILEGES;
```

**MariaDB — 強制輪換密碼**（`R__005_rotate_passwords.sql`）：
```sql
-- ALTER USER 不觸發 Note 1973，因此每次執行都會寫入新密碼
ALTER USER 'app_readonly'@'%'  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
ALTER USER 'app_readwrite'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';
FLUSH PRIVILEGES;
```

**MongoDB — 每個使用者物件各自帶一個佔位符**（`R__003_secret_users.js`）：
```javascript
// users 陣列中每個 entry 各自有 CHANGE_ME_ON_FIRST_LOGIN
// Runner 在執行模組前獨立替換每一個
const users = [
  { username: 'app_readonly',  password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
  { username: 'app_readwrite', password: 'CHANGE_ME_ON_FIRST_LOGIN', roles: [...] },
];

for (const u of users) {
  const exists = (await adminDb.command({ usersInfo: u.username })).users.length > 0;
  if (!exists) {
    await adminDb.command({ createUser: u.username, pwd: u.password, roles: u.roles });
    createdUsernames.push(u.username);
  } else {
    await adminDb.command({ updateUser: u.username, roles: u.roles });
  }
}
return { passwordSet: createdUsernames.length > 0, createdUsernames, allUsernames };
```

**MongoDB `customData` 注入：**  
MongoDB DCL migration 回傳 `{ passwordSet: true }` 時，Runner 會自動對每個新建帳號呼叫 `updateUser` 注入 `customData`：

```json
{
  "expiresAt": "<現在 + DCL_PASSWORD_EXPIRY_DAYS 天>",
  "passwordLastModified": "<現在>",
  "description": "Auto-created user, requires password change before expiry."
}
```

透過環境變數 `DCL_PASSWORD_EXPIRY_DAYS`（預設 `7`）控制有效期天數。

---

#### 多實例指令

**查看所有實例狀態** (`status-all`):
```bash
docker compose run --rm migrate status-all -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**執行所有實例遷移** (`up-all`):
```bash
docker compose run --rm migrate up-all -c /app/databases/mariadb/multi-instance/ddl/config.js

# Dry Run
docker compose run --rm migrate up-all --dry-run -c /app/databases/mariadb/multi-instance/ddl/config.js

# 平行執行
docker compose run --rm migrate up-all --parallel -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**測試所有實例** (`test-instances`):
```bash
docker compose run --rm migrate test-instances -c /app/databases/mariadb/multi-instance/ddl/config.js

# 只驗證（跳過 Up-Down-Up）
docker compose run --rm migrate test-instances --validate-only -c /app/databases/mariadb/multi-instance/ddl/config.js

# 平行執行
docker compose run --rm migrate test-instances --parallel -c /app/databases/mariadb/multi-instance/ddl/config.js
```

**測試所有專案** (`test-all`):

`test-all` 命令自動區分 DCL 和 DDL 配置，使用不同的測試策略:
- **DCL 配置**: 驗證 + 執行 3 次（驗證冪等性）
- **DDL 配置**: 驗證 + 執行 Up-Down-Up 測試（驗證回滾）

```bash
# 測試工作區所有專案
docker compose run --rm migrate test-all -o /app/reports

# 測試特定命名空間（例如 {{ namespace }}）
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/**/config.js" \
  -o /app/reports

# 僅測試 DDL 配置（排除 DCL）
docker compose run --rm migrate test-all \
  --pattern "databases/**/ddl/**/config.js" \
  -o /app/reports

# 僅測試 DCL 配置（驗證冪等性）
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/dcl/config.js" \
  -o /app/reports

# 測試特定資料庫類型
docker compose run --rm migrate test-all \
  --pattern "databases/mongodb/**/config.js" \
  -o /app/reports

# 僅輸出到控制台（不保存報告文件）
docker compose run --rm migrate test-all \
  --pattern "databases/mariadb/{{ namespace }}/ddl/**/config.js" \
  --console-only
```

**多實例 DCL** (`dcl-all` / `dcl:status-all` / `dcl:verify-all`):
```bash
# 執行所有實例 DCL
docker compose run --rm migrate dcl-all -c /app/databases/mariadb/multi-instance/dcl/config.js

# 查看所有實例 DCL 狀態
docker compose run --rm migrate dcl:status-all -c /app/databases/mariadb/multi-instance/dcl/config.js

# 驗證所有實例 DCL 冪等性
docker compose run --rm migrate dcl:verify-all -c /app/databases/mariadb/multi-instance/dcl/config.js
```

---

**路徑說明**:
- 容器內路徑固定以 `/app/databases/` 開頭
- `config.js` 中的 `migrationsDir: './migrations'` 是相對路徑，不需更改

---

### 💻 本地 Node.js 方式

> 本機安裝 Node.js 20+ 後，可直接執行 CLI。

#### 指令格式

```bash
node src/cli.js <command> [options] -c <config-path>
```

#### 常用指令範例

```bash
# 查看狀態
node src/cli.js status -c databases/mariadb/test-success/ddl/config.js

# 執行遷移
node src/cli.js up -c databases/mariadb/test-success/ddl/config.js

# 驗證遷移
node src/cli.js validate -c databases/mariadb/test-success/ddl/config.js

# 批量驗證
node src/cli.js validate-all databases/mariadb/production-server

# 執行 DCL
node src/cli.js dcl -c databases/mariadb/production-server/dcl/config.js

# Up-Down-Up 測試
node src/cli.js test -c databases/mariadb/test-success/ddl/config.js

# 多實例操作
node src/cli.js status-all -c databases/mariadb/multi-instance/ddl/config.js
node src/cli.js up-all -c databases/mariadb/multi-instance/ddl/config.js
```

**完整指令列表**：參考上方 Docker Compose 方式，將 `docker compose run --rm migrate` 替換為 `node src/cli.js`，路徑移除 `/app/` 前綴即可。

---

### 🛡️ 危險操作放行機制

驗證工具會自動檢測危險操作，並提供放行機制：

#### 三級分類系統

| 級別 | 符號 | 說明 | 放行方式 |
|------|------|------|----------|
| **🔴 Forbidden** | ❌ | 絕對禁止，會導致嚴重後果 | `--allow-forbidden` + 團隊審批 |
| **🟠 Dangerous** | ⚠️ | 危險操作，需謹慎評估 | `--allow-dangerous` |
| **⚪ Warning** | 💡 | 提示訊息，不阻擋執行 | 無需放行 |

#### 🔴 Forbidden 操作（MariaDB）

| 操作 | 說明 | 智能允許 |
|------|------|----------|
| `DROP DATABASE` | 刪除整個資料庫 | ✅ 允許在 DOWN（當 UP 有 CREATE DATABASE） |
| `DROP SCHEMA` | 刪除 schema | ✅ 允許在 DOWN（當 UP 有 CREATE） |
| `CREATE USER` | 使用者管理（應在 DCL） | - |
| `DROP USER` | 使用者管理（應在 DCL） | - |
| `GRANT` | 權限管理（應在 DCL） | - |
| `REVOKE` | 權限管理（應在 DCL） | - |

#### 🔴 Forbidden 操作（MongoDB）

| 操作 | 說明 | 智能允許 |
|------|------|----------|
| `dropDatabase()` | 刪除資料庫 | ✅ 允許在 `down()`（當 `up()` 初始化） |
| `createUser()` | 使用者管理（應在 DCL） | - |
| `dropUser()` | 使用者管理（應在 DCL） | - |
| `grantRolesToUser()` | 權限管理（應在 DCL） | - |

#### 🟠 Dangerous 操作（MariaDB）

- `TRUNCATE TABLE` - 清空表資料
- `DROP INDEX` - 刪除索引（影響效能）
- `DROP COLUMN` - 刪除欄位（資料遺失）
- `ALTER TABLE ... DROP FOREIGN KEY` - 移除外鍵約束

#### 🟠 Dangerous 操作（MongoDB）

- `collection.drop()` - 刪除集合
- `deleteMany({})` - 無條件刪除（影響資料）
- `dropIndex()` - 刪除索引（影響效能）

#### 放行範例

```bash
# 放行所有危險操作
docker compose run --rm migrate validate --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js

# 放行特定操作
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c /app/databases/mariadb/test-success/ddl/config.js

# 放行禁止操作（需團隊審批）
docker compose run --rm migrate validate --allow-forbidden -c /app/databases/mariadb/test-success/ddl/config.js

# 執行時也需要相同的放行選項
docker compose run --rm migrate up --allow-dangerous -c /app/databases/mariadb/test-success/ddl/config.js
```

#### CI/CD 整合

```yaml
# .gitlab-ci.yml 範例
validate-migrations:
  script:
    - docker compose run --rm migrate validate -c /app/databases/mariadb/production/ddl/config.js
    # 如果有審批的危險操作
    - docker compose run --rm migrate validate --allow TRUNCATE_TABLE -c /app/databases/mariadb/maintenance/ddl/config.js
  
run-migrations:
  script:
    - docker compose run --rm migrate up -c /app/databases/mariadb/production/ddl/config.js
  when: manual  # 需要手動觸發
```

#### 團隊審批流程建議

1. **開發階段**：嚴格驗證，不放行任何危險操作
2. **Code Review**：如有危險操作，需額外審批
3. **部署前**：再次驗證，確認放行選項正確
4. **Production**：僅在維護窗口執行危險操作

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
│   │       │       ├── 20260101000000-create-database.sql
│   │       │       ├── 20260101000001-create-users.sql
│   │       │       └── 20260101000002-create-products.sql
│   │       ├── analytics/
│   │       │   ├── config.js
│   │       │   └── migrations/
│   │       │       ├── 20260101000000-create-database.sql
│   │       │       ├── 20260101000001-create-events.sql
│   │       │       └── 20260101000002-create-daily-stats.sql
│   │       └── logging/
│   │           ├── config.js
│   │           └── migrations/
│   │               ├── 20260101000000-create-database.sql
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
                    ├── 20260101000000-init-database.js
                    ├── 20260101000001-create-users.js
                    └── 20260101000002-create-products.js
```

**說明**:
- **DDL (Data Definition Language)**: Schema 變更，使用 Versioned 模式（時間戳）
- **DCL (Data Control Language)**: 權限管理，使用 Repeatable 模式（Checksum）
- **production-server**: 展示多資料庫管理，每個資料庫獨立目錄
- **第一個 migration**: 建議為 `20260101000000-create-database.sql`（CREATE DATABASE）

---

### 🔷 實用範例

#### 開發環境工作流程

```bash
# 1. 啟動資料庫
docker compose up -d mongodb mariadb

# 2. 建立新遷移
docker compose run --rm migrate create add-user-roles -c /app/databases/mongodb/test-success/ddl/config.js

# 3. 編輯遷移檔案（實現 up/down 函數）
# vim databases/mongodb/test-success/ddl/migrations/20260211XXXXXX-add-user-roles.js

# 4. 驗證遷移
docker compose run --rm migrate validate -c /app/databases/mongodb/test-success/ddl/config.js

# 5. 執行遷移（先 dry-run）
docker compose run --rm migrate up --dry-run -c /app/databases/mongodb/test-success/ddl/config.js

# 6. 正式執行
docker compose run --rm migrate up -c /app/databases/mongodb/test-success/ddl/config.js

# 7. 測試回滾
docker compose run --rm migrate test -c /app/databases/mongodb/test-success/ddl/config.js
```

#### Production Server 工作流程

```bash
# 1. 先執行 DCL（創建用戶和權限）
docker compose run --rm migrate dcl -c /app/databases/mariadb/production-server/dcl/config.js

# 2. 批量驗證所有 DDL
docker compose run --rm migrate validate-all --ddl-only /app/databases/mariadb/production-server

# 3. 執行各資料庫的 DDL
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/analytics/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/ecommerce/config.js
docker compose run --rm migrate up -c /app/databases/mariadb/production-server/ddl/logging/config.js

# 4. 驗證 DCL 冪等性
docker compose run --rm migrate dcl:verify -c /app/databases/mariadb/production-server/dcl/config.js
```

#### CI/CD 整合

```bash
# 在 CI pipeline 中驗證所有遷移
docker compose run --rm migrate validate -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# 執行完整測試
docker compose run --rm migrate test -c /app/databases/mongodb/test-success/ddl/config.js || exit 1

# 批量驗證 production-server
docker compose run --rm migrate validate-all /app/databases/mariadb/production-server || exit 1

# 部署時執行遷移
docker compose run --rm migrate up -c /app/databases/mongodb/production/ddl/config.js
```

#### 多環境部署

```bash
# 使用環境變數切換環境
MONGO_URL=mongodb://prod-server:27017 \
MONGO_DB=production_db \
docker compose run --rm migrate up -c /app/databases/mongodb/test-success/ddl/config.js

# 或建立環境特定配置
docker compose run --rm migrate status -c /app/databases/mongodb/production/config.js
docker compose run --rm migrate up -c /app/databases/mongodb/staging/config.js
```


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

**重要**: 對於新資料庫，第一個 migration 應該是 CREATE DATABASE：

```sql
-- 20260101000000-create-database.sql

-- +migrate Up
CREATE DATABASE IF NOT EXISTS myapp
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- +migrate Down
-- ⚠️ WARNING: This will drop the entire database and all its data!
-- Only run this in development/testing environments
DROP DATABASE IF EXISTS myapp;
```

**雙重保障機制**:
1. **Adapter 自動創建**: MariaDB adapter 會在連接前自動執行 `CREATE DATABASE IF NOT EXISTS`
2. **顯式 Migration**: 第一個 migration 明確記錄資料庫創建歷史

**智能允許規則**:
- ✅ `CREATE DATABASE` 允許在 UP section
- ✅ `DROP DATABASE` 允許在 DOWN section（當 UP 有創建時）
- ❌ `DROP DATABASE` 禁止在 UP section（防止誤刪）

---

**一般表結構 Migration 範例**:

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

| 類別 | 操作 | 嚴重性 | 說明 |
|------|------|--------|------|
| **危險操作** | `dropDatabase`, `dropAllUsers`, `dropAllRoles` | ❌ Error | `dropDatabase()` 允許在 `down()` 當 `up()` 初始化資料庫 |
| **DCL 操作** | `createUser`, `dropUser`, `updateUser` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **DCL 操作** | `createRole`, `dropRole`, `grantRolesToUser` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **DCL 操作** | `revokeRolesFromUser`, `shutdown` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **空 down()** | up() 有操作但 down() 空白 | ❌ Error | 必須提供回滾邏輯 |
| **孤立 drop** | down() 刪除非 up() 建立的集合 | ❌ Error | 防止誤刪既有資料 |
| **非冪等操作** | `deleteMany({})`, `drop()` 不帶條件 | ⚠️ Warning | 可能影響 DCL 冪等性 |

### MariaDB/MySQL 驗證規則

| 類別 | 操作 | 嚴重性 | 說明 |
|------|------|--------|------|
| **危險操作** | `DROP DATABASE`, `DROP SCHEMA` | ❌ Error | 禁止在 UP；允許在 DOWN（當 UP 有 CREATE DATABASE） |
| **安全操作** | `CREATE DATABASE`, `CREATE SCHEMA` | ✅ Allowed | 允許在 UP；禁止在 DOWN（防止誤創建） |
| **危險操作** | `TRUNCATE TABLE` | ❌ Error | 需要 `--allow-dangerous` 放行 |
| **DCL 操作** | `CREATE USER`, `DROP USER`, `ALTER USER` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **DCL 操作** | `GRANT`, `REVOKE`, `SET PASSWORD` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **DCL 操作** | `FLUSH PRIVILEGES` | ⚠️ Warning | 應移至 DCL repeatable migrations |
| **資料匯出** | `INTO OUTFILE`, `LOAD DATA INFILE` | ⚠️ Warning | 潛在安全風險 |
| **空 Down** | Up 有 SQL 但 Down 空白 | ❌ Error | 必須提供回滾邏輯 |
| **孤立 drop** | Down 刪除非 Up 建立的表 | ❌ Error | 防止誤刪既有資料 |

**智能允許邏輯**:
- `CREATE DATABASE` 在 UP section 自動允許（用於初始化）
- `DROP DATABASE` 在 DOWN section 自動允許（當對應的 UP 有 CREATE DATABASE）
- `DROP DATABASE` 在 UP section 永遠禁止（防止誤刪）
- MongoDB `dropDatabase()` 在 `down()` function 自動允許（當 `up()` 初始化資料庫）

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

# 使用 --pattern 只測試特定目錄
node src/cli.js test-all --pattern "databases/mariadb/production-server/**/config.js"
```

### Pattern 比對說明

`test-all` 支援 glob pattern 選擇性測試資料庫。會自動辨識 DCL / DDL 配置並套用對應的測試策略：

```bash
# 測試 production-server 下所有設定（DCL + DDL）
node src/cli.js test-all --pattern "databases/mariadb/production-server/**/config.js"

# 只測試 DDL 設定
node src/cli.js test-all --pattern "databases/mariadb/production-server/ddl/**/config.js"

# 只測試 DCL 設定（會執行 3 次冪等性驗證）
node src/cli.js test-all --pattern "databases/mariadb/production-server/dcl/config.js"

# 測試所有 MongoDB 資料庫
node src/cli.js test-all --pattern "databases/mongodb/**/ddl/config.js"
```

**`--base-dir` 選項**：

當 config 檔案存放在 workspace 以外的位置（例如掛載的外部 volume、NFS），使用 `--base-dir` 指定搜尋根目錄，`--pattern` 則填入**相對於該目錄**的路徑。

```bash
# 情境：config 在外部路徑
#   /s/project/dcl/config.js
#   /s/project/ddl/aaa/config.js
#   /s/project/ddl/bbb/config.js

# 使用 --base-dir 指定根目錄，--pattern 填相對路徑
node src/cli.js test-all \
  --base-dir /s \
  --pattern "project/**/config.js"

# 不使用 --base-dir，pattern 須相對於 cwd
node src/cli.js test-all \
  --pattern "databases/mariadb/project/**/config.js"
```

| 情境 | `--base-dir` | `--pattern` |
|---|---|---|
| config 在 workspace 內 | _(省略)_ | `databases/mariadb/demo/**/config.js` |
| config 在外部 volume | `/s` | `project/**/config.js` |
| 只有一層子目錄 | `/s` | `project/*/config.js` |
| 有多層巢狀子目錄 | `/s` | `project/**/config.js` |

> **`*` vs `**` 的差異**：
> - `*` 只匹配**一層**目錄（如 `dcl/config.js`）
> - `**` 匹配**零層或多層**目錄（如 `ddl/aaa/config.js`、`ddl/bbb/config.js`）
> - 有巢狀子資料庫時請使用 `**`

**Pattern 語法**：
- `**` — 匹配任意層數目錄（遞迴）
- `*` — 匹配單層任意字元（不含 `/`）
- 路徑相對於 `--base-dir`（未指定則相對於 cwd）

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
