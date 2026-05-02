# DB-Migrate v2.1

> 統一的多資料庫遷移管理工具，支援 MongoDB 與 MariaDB/MySQL，包含多實例同步測試、DDL 版本化遷移與 DCL Repeatable 模式

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](package.json)

## �� 特點

- **多資料庫支援**: MongoDB (via migrate-mongo) 和 MariaDB/MySQL (sql-migrate 模式)
- **多實例支援**: 同時管理多個資料庫實例 (如 primary/secondary/tertiary)
- **雙遷移模式**:
  - **Versioned (DDL)**: 時間戳版本化，需要 up/down 遷移
  - **Repeatable (DCL)**: Checksum 驅動，自動偵測變更並重新執行
- **統一 CLI**: 單一命令行界面管理所有資料庫遷移
- **驗證規則**: 自動檢測危險操作、空 down()、孤立 drop、DCL 操作混入 DDL、SQL 語法錯誤 (MariaDB)、FK 完整性檢查 (MariaDB DDL)
- **DCL 自動生成密碼**: 每個 `CHANGE_ME_ON_FIRST_LOGIN` 佔位符在執行時各自替換為獨立的高強度 16 字元密碼——原始檔案永不修改；憑證寫入 `/tmp/secret`
- **Sanity Check**: 內建 Pre-Check / Post-Check / Auto-Rollback 機制
- **報表生成**: 支援 JSON、HTML 格式

---

## 📦 安裝

```bash
git clone https://github.com/your-org/db-migrate.git
cd db-migrate
npm install
```

---

## 🚀 快速開始

### 1. 啟動測試資料庫

```bash
docker compose up -d mongodb mariadb
```

### 2. 執行範例遷移

```bash
# MongoDB 範例
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js status
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up

# MariaDB 範例
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up
```

### 3. 驗證遷移

```bash
node src/cli.js validate -c test-fixtures/mariadb/test-success/ddl/config.js
```

### 4. 建立新遷移

```bash
node src/cli.js create add-users-table -c test-fixtures/mariadb/test-success/ddl/config.js
```

### 5. 執行 Up-Down-Up 測試

```bash
node src/cli.js test -c test-fixtures/mariadb/test-success/ddl/config.js
```

---

## 📖 基本使用

### 指令列表

| 指令 | 說明 |
|------|------|
| `status` | 查看遷移狀態 |
| `up` | 執行待處理的遷移 |
| `down -n <N>` | Rollback 最近 N 個遷移 |
| `create <name>` | 建立新 DDL 遷移檔案 |
| `validate` | 驗證遷移檔案 |
| `validate-all <dir>` | 批量驗證整個目錄 |
| `test` | 執行 Up-Down-Up 測試 |
| `test-all` | 執行所有遷移測試並生成報表 |
| `dcl` | 執行 DCL (repeatable) 遷移 |
| `dcl:verify` | 驗證 DCL 冪等性 |
| `dcl:status` | 查看 DCL 遷移狀態 |
| `create-dcl <name>` | 建立新 DCL 遷移檔案 |
| `baseline` | 將現有遷移設為基準線 |

### 指令格式

```bash
# 本地執行
node src/cli.js <command> [options] -c <config-path>

# Docker
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

---

## 📄 配置範例

### Config Defaults & Delta Pattern

`loadConfig()` 根據 `type` + `mode` 自動從 `src/config-defaults/` 載入內建預設值，然後將使用者 config 深層合併進去。你的 `config.js` 只需填寫與預設值不同的欄位。

### MongoDB DDL 配置

```javascript
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGO_DB || 'myapp' }
};
```

### MariaDB DDL 配置

```javascript
// host/port/user/password 從環境變數 (MARIADB_HOST 等) 或預設值讀取
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
```

### MongoDB DCL 配置

```javascript
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },
  checksumCollection: '_dcl_migrations'
};
```

### MariaDB DCL 配置

```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',
  checksumTable: '_dcl_migrations'
};
```

---

## 📂 專案結構

```
ddl-migrate/
├── src/                          # 核心程式碼
│   ├── cli.js
│   ├── core/
│   ├── adapters/
│   └── config-defaults/
├── test-fixtures/                # 整合測試用例 (連接真實 DB)
│   ├── mariadb/
│   │   ├── test-success/
│   │   ├── test-failure/
│   │   ├── multi-instance/
│   │   ├── production-server/
│   │   ├── dcl-scenario-test/
│   │   └── fk-test/
│   └── mongodb/
│       ├── test-success/
│       ├── test-failure/
│       ├── multi-instance/
│       └── production-server/
├── test/                         # 單元測試
├── scripts/                      # CI/建置腳本
│   ├── build-migration-image.sh
│   ├── ci-migration-test.sh
│   ├── full-migration-test.sh
│   ├── local-test.sh
│   ├── run-tests.sh
│   └── smoke-test.sh
├── docker/
├── docs/                         # 詳細文件
└── [配置文件]
```

---

## 🛡️ 驗證規則

`validate` 指令對每個遷移檔案進行以下檢查：

- **禁止操作**: `DROP DATABASE`、`CREATE USER`、`GRANT` 等出現在 DDL 中 (應放在 DCL)
- **危險操作**: `TRUNCATE TABLE`、`DROP COLUMN`、`DROP INDEX`、`collection.drop()` 等
- **SQL 語法錯誤** (MariaDB): 使用 `node-sql-parser` 在規則檢查前預先驗證
- **FK 完整性** (MariaDB DDL): 偵測指向已刪除或從未建立的表格的 FK
- **空 down()**: UP 有操作但 DOWN 為空
- **孤立 drop**: DOWN 刪除了 UP 未建立的表格/集合

### 允許機制

```bash
# 允許所有危險操作 (CLI flag)
node src/cli.js validate --allow-dangerous -c <config>

# 允許特定操作代碼
node src/cli.js validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

檔案內標注 (推薦 — 讓審核記錄保留在 code review 中):

```sql
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

詳細規則請參考 [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md)。

---

## 📚 文件索引

| 文件 | 說明 |
|------|------|
| [DOCKER-USAGE.md](docs/DOCKER-USAGE.md) | Docker Compose 完整指令參考 |
| [DCL-PASSWORD.md](docs/DCL-PASSWORD.md) | DCL 自動生成密碼機制 |
| [MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md) | 多實例配置指南 |
| [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | test-all、validate-all、CI/CD 整合 |
| [VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) | 完整驗證規則參考 |
| [CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) | 詳細 CLI 使用指南 |
| [EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) | 現有資料庫導入指南 |

---

## 🤝 貢獻

1. Fork 此 repository
2. 建立 feature branch
3. 執行單元測試: `npm test`
4. 提交 pull request

---

## 📝 授權

MIT License - 詳見 [LICENSE](LICENSE) 文件。
