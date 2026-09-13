# DB-Migrate v2.1

> 統一的 DDL + DCL 遷移工具,支援 MongoDB 與 MariaDB/MySQL —— 版本化的結構遷移、可重複執行的帳號權限管理、多實例部署,以及正式環境所需的防護機制(鎖等待保護、危險操作驗證、Sanity Check),全部整合在一支 CLI 裡。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](package.json)

第一次用?[QUICKSTART.md](QUICKSTART.md) 是依「我想做什麼」分類的任務導向操作手冊。這份 README 是參考手冊:工具做什麼、每個指令的選項、每種設定檔的寫法,以及更深入文件的索引。

---

## 🎯 為什麼要用這個工具

大多數遷移工具只處理結構變更(DDL)就結束了。這個工具把**帳號權限管理(DCL)**也當成一等公民 —— 一樣是版本化、冪等、有 checksum 追蹤的遷移類型 —— 並且加上把兩者指向共用或正式環境資料庫前,你真正需要的防護機制:

- **雙遷移模式,同一支 CLI**
  - **DDL(版本化)** —— 時間戳排序的 `up()`/`down()` 遷移,標準的結構變更模式。
  - **DCL(Repeatable)** —— checksum 驅動的 `R__*` 腳本,管理使用者/角色/權限。檔案內容變了就自動重跑,執行前還會先驗證冪等性。
- **多實例(Multi-Instance)** —— 用同一份設定和一整組 `*-all` 指令,把同一套遷移套用到 N 個資料庫實例(primary/secondary/tertiary、多個 shard 專案…)。
- **`sync`** —— 「讓它變成該有的樣子」指令:`status` → `up` → git-diff 風格的 before/after schema 差異 → 直接從資料庫查回來的真實現況(不是照遷移檔案推測的)。它不會安靜地什麼都不做:如果執行當下沒有任何待處理的遷移,會回傳非 0 的錯誤結束碼,讓 CI/CD 不會把「這次沒事做」誤判成「部署成功」。
- **`dcl` 會告訴你真正改了什麼** —— DCL 執行完後,會比對執行前後的帳號與權限狀態(MariaDB、MongoDB 都支援)並印出差異,讓審核者看到實際效果,而不只是「migration 已套用」這種空話。
- **執行前先驗證** —— 禁止操作(DCL 語句混進 DDL)、危險操作(`TRUNCATE`、`DROP COLUMN`、`collection.drop()` 等)、空的 `down()`、孤立的 drop、FK 完整性(MariaDB)、SQL 語法預先檢查 —— 每一種都有明確、可審查的放行機制(`--allow`、檔案內 `@allow` 標註),而不是靜默略過。
- **Lock Guard(MariaDB)** —— 每一條 DDL 語句都在有上限的 `lock_wait_timeout` 底下執行,並附帶重試機制,讓卡在其他長交易 metadata lock 後面的 `ALTER TABLE` 快速失敗,而不是無限排隊、卡住這張表後面所有查詢。詳見 [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md)。
- **Sanity Check** —— 每個遷移可選配 Pre-Check / Post-Check 斷言,後置條件不成立時自動 rollback。
- **DCL 自動生成密碼** —— DCL 腳本裡的 `CHANGE_ME_ON_FIRST_LOGIN` 佔位符,在執行當下會被換成各自獨立產生的高強度密碼(絕不印出、絕不寫回原始檔案);憑證會附加寫入 `/tmp/secret` 供一次性取用。詳見 [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md)。
- **報表** —— `sync`、`test-all`、`test-instances` 都能用 `-o <dir>` 產出 JSON + HTML 報表。
- **Kubernetes-ready** —— [`k8s/`](k8s/) 目錄有範例 manifest,把 `sync` 包成一次性 Job 執行,憑證來自 Secret、遷移檔案來自內容雜湊過的 ConfigMap。

---

## 📦 安裝

```bash
git clone https://github.com/your-org/db-migrate.git
cd db-migrate
npm install
```

需要 Node.js ≥ 20。要連接真實資料庫做本機開發的話還需要 Docker —— 在 Windows 上代表要先啟用 WSL2 後端(`wsl --install`,因為 Windows Home 沒有 Hyper-V)。

---

## 🚀 快速開始

```bash
# 1. 啟動測試資料庫
docker compose up -d mongodb mariadb

# 2. 查看狀態,然後套用
node src/cli.js status  -c test-fixtures/mariadb/test-success/ddl/config.js
node src/cli.js up      -c test-fixtures/mariadb/test-success/ddl/config.js

# 3. 執行前先驗證
node src/cli.js validate -c test-fixtures/mariadb/test-success/ddl/config.js

# 4. 建立新遷移
node src/cli.js create add-users-table -c test-fixtures/mariadb/test-success/ddl/config.js

# 5. 確認來回乾淨 (up → down → up)
node src/cli.js test -c test-fixtures/mariadb/test-success/ddl/config.js
```

以上指令都可以用 `docker compose run --rm migrate <command> ...` 取代 `node src/cli.js` 執行。完整的任務導向操作手冊(DCL 帳號設定、多實例、完整測試流程、MongoDB 角色)請看 **[QUICKSTART.md](QUICKSTART.md)**。

---

## 📖 核心概念

### DDL vs. DCL

| | DDL(版本化) | DCL(Repeatable) |
|---|---|---|
| 用途 | 結構變更(表格、欄位、索引、collection) | 帳號、角色、授權/撤銷 |
| 檔名規則 | `<timestamp>-<name>.{sql,js}` | `R__<name>.{sql,js}` |
| 執行順序 | 依時間戳排序套用,記錄在 changelog | 檔案 checksum 變了就重跑 |
| Rollback | 需要 `down()` | 不適用 —— 必須寫成冪等 |
| 正確性檢查 | Up-Down-Up 測試 (`test`) | 冪等性檢查 (`dcl:verify`) |

### Config Defaults 與 Delta Pattern

`loadConfig()` 會依 `type` + `mode` 從 `src/config-defaults/` 自動載入內建預設值(`mariadb-ddl.js`、`mariadb-dcl.js`、`mongodb-ddl.js`、`mongodb-dcl.js`),再把你的設定深層合併進去。**`config.js` 只需要填寫與預設值不同的欄位** —— host/port/密碼、Lock Guard 調整參數等都有合理的預設值。

### 多實例(Multi-Instance)

設定檔可以用 `instances: [...]` 陣列取代(或搭配)平鋪的連線欄位;每個指令都有對應的 `*-all` 版本(`up-all`、`status-all`、`dcl-all`、`dcl:status-all`、`dcl:verify-all`、`test-instances`)可以一次跑遍所有實例。詳見 [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md)。

---

## 🛠️ CLI 指令參考

```bash
# 本地執行
node src/cli.js <command> [options] -c <config-path>

# Docker
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

### DDL —— 單一實例

| 指令 | 說明 |
|---|---|
| `status` | 查看已套用 / 待處理的 migrations |
| `up [--dry-run] [--sanity-check] [--no-auto-rollback] [--target <m>] [--only <m>] [--instance <n>]` | 執行待處理的 migrations |
| `sync [--sanity-check] [--target <m>] [--only <m>] [-o <dir>]` | `status` → `up` → 差異 → 真實現況。**沒有待處理項目時會回傳非 0 錯誤碼** —— 見 [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) |
| `down -n <N> [--target <m>] [--instance <n>]` | Rollback 最近 N 個 migration |
| `baseline [--all \| --up-to <m> \| --file <f>] [--dry-run]` | 既有資料庫導入時,把現有 migration 標為「已套用」而不實際執行 —— 見 [docs/EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) |
| `reset [--yes]` | 只刪除 changelog/checksum 紀錄 —— **絕不**執行 `down()` 或動到 schema/data。不加 `--yes` 只會 dry-run 計數 |
| `create <name>` | 建立新的 DDL migration 檔案 |
| `validate [--allow-dangerous] [--allow-forbidden] [--allow <codes>]` | 驗證 migration 檔案(見下方[驗證](#🛡️-驗證)章節) |
| `test` | Up-Down-Up 來回測試 |

### DDL —— 多實例

| 指令 | 說明 |
|---|---|
| `status-all` | 對設定檔內所有實例執行 `status` |
| `up-all [--dry-run]` | 對所有實例執行 `up` |
| `test-instances [-o <dir>] [--validate-only] [--parallel]` | 對所有實例執行 `test`(或只做 `validate`),並產出合併報表 |
| `validate-all <dir> [--ddl-only \| --dcl-only] [--allow-*]` | 走遍整個專案目錄(DDL + DCL)並全部驗證一遍 —— 例如 `production-server/` |

### DCL —— 單一實例

| 指令 | 說明 |
|---|---|
| `dcl [--dry-run] [--validate] [--allow-dangerous] [--allow-forbidden]` | 執行待處理/已變更的 repeatable 腳本,結束後印出帳號/權限 before/after 差異 |
| `dcl:status` | 查看各 `R__*` 腳本的套用狀態、checksum 是否吻合 |
| `dcl:verify` | 跑兩次並比對狀態以確認冪等性,不會留下實際變更 |
| `create-dcl <name> [-n <seq>]` | 建立新的 `R__` DCL 遷移檔案 |

### DCL —— 多實例

| 指令 | 說明 |
|---|---|
| `dcl-all [--dry-run] [--validate] [--allow-*]` | 對所有實例執行 `dcl` |
| `dcl:status-all` | 對所有實例執行 `dcl:status` |
| `dcl:verify-all` | 對所有實例執行 `dcl:verify` |

### 測試與報表

| 指令 | 說明 |
|---|---|
| `test` | 單一設定檔的 Up-Down-Up 測試 |
| `test-instances -o <dir>` | 所有實例的 Up-Down-Up(或只驗證) |
| `test-all [-o <dir>] [--pattern <glob>] [--base-dir <dir>] [--console-only] [--sanity-check]` | 依 glob 找出所有 `config.js`,對每個執行 validate + Up-Down-Up(DDL)或 validate + 冪等性檢查(DCL),產出合併的通過/失敗報表 |

---

## 📄 配置範例

### MongoDB DDL

```javascript
// 只需填寫與預設值不同的欄位
export default {
  type: 'mongodb',
  mongodb: { databaseName: process.env.MONGODB_DB || 'myapp' }
};
```

### MariaDB DDL

```javascript
// host/port/user/password 從環境變數 (MARIADB_HOST 等) 或預設值讀取
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  changelogTable: '_migrations'
};
```

每個 MariaDB DDL 專案預設都會啟用 **Lock Guard**(每個 migration 的 SQL 都套上有上限的鎖等待 + 重試)。需要的話可以逐專案覆寫:

```javascript
export default {
  type: 'mariadb',
  database: process.env.MARIADB_DB || 'myapp',
  ddlSafety: {
    lockGuard: {
      enabled: true,          // 設 false 恢復舊的無防護行為
      lockWaitTimeoutSec: 5,  // 執行 migration SQL 期間的 SESSION lock_wait_timeout
      innodbLockWaitTimeoutSec: 5,
      maxRetries: 3,          // 超過這個重試次數就放棄
      retryDelayMs: 2000
    }
  }
};
```

這個機制存在的原因、保護範圍與限制見 [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md)。

### MongoDB DCL

```javascript
export default {
  type: 'mongodb',
  mode: 'repeatable',
  mongodb: { databaseName: 'admin' },
  checksumCollection: '_dcl_migrations'
};
```

### MariaDB DCL

```javascript
export default {
  type: 'mariadb',
  mode: 'repeatable',
  database: 'mysql',
  checksumTable: '_dcl_migrations'
};
```

### 多實例(兩種類型皆適用)

```javascript
export default {
  type: 'mariadb',
  instances: [
    { name: 'primary-db',   mariadb: { host: 'db-primary',   database: 'shop' } },
    { name: 'secondary-db', mariadb: { host: 'db-secondary', database: 'shop' } }
  ]
};
```

完整說明:[docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md)。

---

## 📂 專案結構

```
db-migrate/
├── src/                          # 核心程式碼
│   ├── cli.js                    # 所有指令
│   ├── core/                     # RepeatableRunner、DCLIdempotentChecker、Reporter…
│   ├── adapters/                 # mariadb-adapter.js、mongodb-adapter.js
│   └── config-defaults/          # mariadb-ddl.js、mariadb-dcl.js、mongodb-ddl.js、mongodb-dcl.js
├── test-fixtures/                # 整合測試用例(連接真實 DB)
│   ├── mariadb/                  # test-success、test-failure、multi-instance、production-server、fk-test…
│   └── mongodb/                  # test-success、test-failure、multi-instance、production-server
├── test/                         # 單元測試 (vitest)
├── scripts/                      # CI/建置 shell 腳本
├── docker/                       # 容器 entrypoint
├── k8s/                          # `sync` 作為 Kubernetes Job 的範例 manifest
└── docs/                         # 深入文件(索引見下方)
```

---

## 🛡️ 驗證

`validate` 指令對每個遷移檔案進行以下檢查:

- **禁止操作**:`DROP DATABASE`、`CREATE USER`、`GRANT` 等出現在 DDL 檔案中(這些應該放在 DCL)
- **危險操作**:`TRUNCATE TABLE`、`DROP COLUMN`、`DROP INDEX`、`collection.drop()` 等
- **SQL 語法錯誤**(MariaDB):在規則檢查前先用 `node-sql-parser` 預先驗證
- **FK 完整性**(MariaDB DDL):偵測指向已刪除或從未建立的表格的外鍵
- **空 `down()`**:`up()` 有操作但 `down()` 沒有還原
- **孤立的 drop**:`down()` 刪除了 `up()` 從未建立的表格/collection

### 放行機制

```bash
# 允許所有危險操作 (CLI flag)
node src/cli.js validate --allow-dangerous -c <config>

# 允許特定操作代碼
node src/cli.js validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

檔案內標註(推薦 —— 讓核准紀錄保留在 code review 裡):

```sql
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

完整規則:[docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md)、[docs/VALIDATION-RULES-MARIADB.md](docs/VALIDATION-RULES-MARIADB.md)、[docs/VALIDATION-RULES-MONGODB.md](docs/VALIDATION-RULES-MONGODB.md)。

---

## 🚢 部署

- **Docker Compose** —— 主要的本機開發/CI 工作流程。完整指令參考:[docs/DOCKER-USAGE.md](docs/DOCKER-USAGE.md)、[docs/DOCKER-COMPOSE-USER-GUIDE.md](docs/DOCKER-COMPOSE-USER-GUIDE.md)。
- **Kubernetes** —— [`k8s/`](k8s/) 目錄的範例 manifest 把 `sync` 包成一次性 Job:ServiceAccount 只能存取單一 Secret、遷移檔案透過內容雜湊過的 ConfigMap 送入、`backoffLimit: 0`(半套用失敗的 DDL 遷移應該讓人介入,而不是被排程器安靜地自動重跑)。完整工作流程、pre-flight 檢查清單,以及為什麼 Secret 裡的帳號**不該**是資料庫 superuser,見 [`k8s/README.md`](k8s/README.md)。

---

## 🧪 測試

```bash
npm test                 # 單元測試 (vitest)
npm run test:integration # 對真實 DB 的整合測試 (vitest.integration.config.js)
npm run docker:test      # 完整 e2e:建 image、啟動 MongoDB + MariaDB、跑 test-all
```

`docker:test` 是最貼近實際情況的檢查方式 —— 跟 CI pipeline 跑的是同一個 `test-all` 指令,對著真的容器跑,產出同樣的 JSON/HTML 報表。詳見 [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md)、[docs/CI-MIGRATION-TEST-GUIDE.md](docs/CI-MIGRATION-TEST-GUIDE.md)。

---

## 📚 文件索引

| 文件 | 說明 |
|---|---|
| [DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) | **正式環境 DDL 風險必讀** —— 什麼情況會鎖死、pre-flight 檢查清單、中止/回滾手冊 |
| [LOCK-GUARD.md](docs/LOCK-GUARD.md) | MariaDB 鎖等待防護:設定、錯誤行為、能保護什麼與不能保護什麼 |
| [RUNTIME-GATE-PLAN.md](docs/RUNTIME-GATE-PLAN.md) | 執行前就緒閘門(設計文件,尚未全部實作) |
| [VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md) | 完整驗證規則參考 |
| [VALIDATION-RULES-MARIADB.md](docs/VALIDATION-RULES-MARIADB.md) | MariaDB 驗證規則表、FK 完整性檢查 |
| [VALIDATION-RULES-MONGODB.md](docs/VALIDATION-RULES-MONGODB.md) | MongoDB 驗證規則表 |
| [DCL-PASSWORD.md](docs/DCL-PASSWORD.md) | DCL 自動生成密碼機制 |
| [MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md) | 多實例配置指南 |
| [EXISTING-DATABASE-ONBOARDING.md](docs/EXISTING-DATABASE-ONBOARDING.md) | 用 `baseline` 導入既有資料庫 |
| [CLI-USAGE-GUIDE.md](docs/CLI-USAGE-GUIDE.md) | 詳細 CLI 使用指南 |
| [USER-GUIDE-MARIADB.md](docs/USER-GUIDE-MARIADB.md) / [USER-GUIDE-MONGODB.md](docs/USER-GUIDE-MONGODB.md) | 各資料庫的使用者指南 |
| [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | `test-all`、`validate-all`、CI/CD 整合 |
| [CI-MIGRATION-TEST-GUIDE.md](docs/CI-MIGRATION-TEST-GUIDE.md) | 把遷移測試接進 CI |
| [DOCKER-USAGE.md](docs/DOCKER-USAGE.md) / [DOCKER-COMPOSE-USER-GUIDE.md](docs/DOCKER-COMPOSE-USER-GUIDE.md) | Docker Compose 指令參考 |
| [BUILD-IMAGE-GUIDE.md](docs/BUILD-IMAGE-GUIDE.md) | 建置遷移用 image |
| [LOCAL-TEST-GUIDE.md](docs/LOCAL-TEST-GUIDE.md) | 不用 Docker,在本機跑測試套件 |
| [MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md](docs/MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md) | Ops-runbook 風格的遷移管理指南 |
| [`k8s/README.md`](k8s/README.md) | 把 `sync` 跑成 Kubernetes Job |

---

## 🤝 貢獻

1. Fork 此 repository
2. 建立 feature branch
3. 執行單元測試:`npm test`(如果動到 adapter/執行邏輯,也跑一次 `npm run docker:test`)
4. 提交 pull request

---

## 📝 授權

MIT License - 詳見 [LICENSE](LICENSE) 文件。
