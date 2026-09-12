# Quick Start — 依任務分類的操作手冊

> 這份文件依「我想做什麼」分類,教你怎麼用 `docker compose run --rm migrate` 完成常見任務。
> 完整指令選項、設定檔格式、驗證規則等參考資料請看 [README.md](README.md)。

---

## 0. 前置需求 & 啟動資料庫

- **Docker Desktop**。在 Windows 上,Docker Desktop 需要 WSL2 才能啟動引擎(Windows Home 沒有 Hyper-V):
  ```powershell
  # 以系統管理員身分開 PowerShell,執行後重開機
  wsl --install
  ```
  裝完、重開機後啟動 Docker Desktop 即可(它會自動註冊 `docker-desktop` 這個 WSL2 發行版)。
- 或者:本機 Node.js ≥ 20,自行準備可連線的 MariaDB/MongoDB。

啟動測試資料庫:

```bash
docker compose up -d mariadb mongodb
```

指令基本格式:

```bash
# 本地執行
node src/cli.js <command> [options] -c <config-path>

# Docker(推薦,環境一致)
docker compose run --rm migrate <command> [options] -c /app/test-fixtures/<db-type>/<project>/config.js
```

以下範例統一用 Docker 寫法,把路徑換成你自己專案的 config 即可。

---

## 我想... 建立並套用一個新的 DDL migration(結構變更)

```bash
# 1. 建立新 migration
docker compose run --rm migrate create create-users -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 2. 編輯 config.js — 只需填寫與預設值不同的欄位 (delta)
#    export default {
#      type: 'mariadb',
#      database: process.env.MARIADB_DB || 'myapp',
#    };

# 3. 編輯產生的 SQL/JS 檔案 (寫 Up,也寫 Down — 空的 Down 會被 validate 擋下來)

# 4. 驗證
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. 套用
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

### DDL 指令速查

| 指令 | 說明 |
|------|------|
| `status` | 查看 migration 狀態 |
| `up` | 執行待處理的 migrations |
| `up --sanity-check` | 執行並做 Pre-Check/Post-Check(失敗自動 rollback) |
| `up --dry-run` | 預覽要執行的 migrations,不實際跑 |
| `down -n 1` | Rollback 最近 1 個 migration |
| `validate` | 驗證 migration 檔案(語法、危險操作、FK 完整性…) |
| `test` | 執行 Up→Down→Up 測試,確認來回都乾淨 |
| `create <name>` | 建立新 migration |
| `baseline --all` | 既有資料庫導入時,把現有 migration 標記為「已套用」而不實際執行 |

---

## 我想... 一次「套用 + 看差異 + 現在的 schema 長怎樣」

這是 `sync` 的用途 —— 適合 CI/CD 或部署流程,取代手動跑 `status` → `up` → 再自己確認的三步驟:

```bash
docker compose run --rm migrate sync -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 需要存檔的 JSON+HTML 報表(例如給 CI 上傳成 artifact)
docker compose run --rm migrate sync -o /app/reports -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

`sync` 會依序:
1. 檢查目前狀態(`status`)
2. 套用所有待處理的 migrations(`up`)
3. 印出 **before/after 的 schema diff**(git-diff 風格,而不是丟兩份完整清單要你自己比對)
4. 印出套用後、直接從資料庫查回來的**真實 schema**(不是照 migration 檔案推測的)

⚠️ **注意**:如果執行當下沒有任何待處理的 migration,`sync` 會**回傳非 0 的錯誤結束碼**,而不是安靜地什麼都不做 —— 這是刻意設計,避免 CI/CD 把「這次沒事做」誤判成「部署成功」。細節見 [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md)。

想直接部署到 Kubernetes 當一次性 Job 跑 `sync`?看下面的[部署到 Kubernetes](#我想-部署到-kubernetes)。

---

## 我想... 建立/修改 DCL 帳號權限(Repeatable 模式)

```bash
# 1. 建立新 DCL 遷移
docker compose run --rm migrate create-dcl readonly_users -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 2. 編輯 config.js — 一樣只填 delta
#    export default {
#      type: 'mariadb',
#      mode: 'repeatable',
#      database: 'mysql',
#      checksumTable: '_dcl_migrations',
#    };

# 3. 編輯 migrations/*.sql 中的帳號和權限(務必寫成冪等 —— 例如 CREATE USER IF NOT EXISTS)

# 4. 先驗證冪等性,再真的執行
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js
```

`dcl` 執行完之後會印出**這次帳號/權限的 before/after 差異**(MariaDB 和 MongoDB 都支援),讓 reviewer 一眼看到「這次到底改了什麼」,而不用自己去資料庫裡對帳號清單。

之後要調整權限或新增帳號,直接編輯 SQL/JS 檔案、重跑 `dcl` 即可 —— checksum 變了才會重新執行,沒變的檔案會被跳過。

### DCL 指令速查

| 指令 | 說明 |
|------|------|
| `dcl` | 執行 DCL migrations,結束後印帳號/權限 diff |
| `dcl --dry-run` | 預覽要執行的 DCL,不實際跑 |
| `dcl:status` | 查看各 DCL 檔案的套用狀態與 checksum 是否吻合 |
| `dcl:verify` | 驗證 DCL 冪等性(跑兩次比對狀態,不留下實際變更) |
| `create-dcl <name>` | 建立新 DCL 檔案 |

密碼怎麼處理?看 [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md) —— 簡單說,遷移檔裡的 `CHANGE_ME_ON_FIRST_LOGIN` 佔位符會在執行當下被換成獨立產生的高強度密碼,原始檔案不會被改動,密碼寫到 `/tmp/secret`(這是容器內路徑;如果你在原生 Windows 直接跑 CLI 而不透過 Docker,這條路徑不存在,務必透過 `docker compose run` 執行 DCL)。

---

## 我想... 對多個資料庫實例做同樣的事(Multi-Instance)

如果 config.js 用 `instances: [...]` 定義了多個實例(例如 primary/secondary),每個單實例指令都有對應的 `*-all` 版本:

```bash
docker compose run --rm migrate status-all      -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
docker compose run --rm migrate up-all          -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
docker compose run --rm migrate dcl-all         -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate dcl:status-all  -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate dcl:verify-all  -c /app/test-fixtures/mariadb/multi-instance/dcl/config.js
docker compose run --rm migrate test-instances -o /app/reports -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js
```

設定檔寫法與完整說明見 [docs/MULTI-INSTANCE.md](docs/MULTI-INSTANCE.md)。

---

## 我想... 驗證整個專案目錄(不只單一 config)

```bash
# 驗證一個專案下所有 DDL + DCL migration
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server

# 只驗證 DDL 或只驗證 DCL
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server --ddl-only
docker compose run --rm migrate validate-all /app/test-fixtures/mariadb/production-server --dcl-only
```

驗證擋到危險/被禁止的操作時,有兩種放行方式(擇一):

```bash
# CLI 參數放行(整次執行有效)
docker compose run --rm migrate validate --allow-dangerous -c <config>
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

```sql
-- 檔案內標註放行(推薦 —— 核准紀錄會留在 code review 裡)
-- @allow: DROP_COLUMN
-- Approved: deprecated since v2.0 (ticket #123)

-- +migrate Up
ALTER TABLE users DROP COLUMN old_field;
```

完整驗證規則見 [docs/VALIDATION-RULES-REFERENCE.md](docs/VALIDATION-RULES-REFERENCE.md)。

---

## 我想... 跑完整測試流程

```bash
# 單一 config:Up → Down → Up 來回測試
docker compose run --rm migrate test -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 多實例:對每個實例都跑一次
docker compose run --rm migrate test-instances -o /app/reports -c /app/test-fixtures/mariadb/multi-instance/ddl/config.js

# 整個專案(甚至整個 test-fixtures/):validate + Up-Down-Up / 冪等性,一次跑完並產出報表
docker compose run --rm migrate test-all -o /app/reports --pattern "test-fixtures/**/config.js"
```

或者本地端一鍵跑(等同 CI 用的 e2e 流程,會自動建 image + 啟動 DB + 跑 `test-all`):

```bash
npm run docker:test
```

手動分步驟測試流程範例:

```bash
# 1. 啟動 DB
docker compose up -d mariadb

# 2. DCL — 建立帳號
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mariadb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mariadb/my-project/dcl/config.js

# 3. DDL — 驗證
docker compose run --rm migrate validate -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 4. DDL — Up(帶 sanity check)
docker compose run --rm migrate up --sanity-check -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 5. DDL — Down
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mariadb/my-project/ddl/config.js

# 6. DDL — 再 Up 一次
docker compose run --rm migrate up -c /app/test-fixtures/mariadb/my-project/ddl/config.js
```

---

## 🍃 MongoDB 操作指南

### DCL(帳號權限管理)

```bash
docker compose run --rm migrate create-dcl my_users -c /app/test-fixtures/mongodb/my-project/dcl/config.js
docker compose run --rm migrate dcl:verify -c /app/test-fixtures/mongodb/my-project/dcl/config.js
docker compose run --rm migrate dcl -c /app/test-fixtures/mongodb/my-project/dcl/config.js
```

### DDL(結構變更)

```bash
docker compose run --rm migrate create create-users -c /app/test-fixtures/mongodb/my-project/ddl/config.js
docker compose run --rm migrate up -c /app/test-fixtures/mongodb/my-project/ddl/config.js
docker compose run --rm migrate test -c /app/test-fixtures/mongodb/my-project/ddl/config.js
```

### MongoDB 內建角色參考

| 角色 | 權限 |
|------|------|
| `read` | 唯讀(find, listCollections) |
| `readWrite` | 讀寫(CRUD 操作) |
| `dbAdmin` | 資料庫管理(索引、統計、驗證) |
| `dbOwner` | 完整權限(readWrite + dbAdmin + userAdmin) |
| `userAdmin` | 使用者管理 |

---

## 我想... 部署到 Kubernetes

[`k8s/`](k8s/) 目錄有一組範例 manifest,把 `sync` 包成一次性 Job 執行:

- 憑證來自 Secret(**不要**放資料庫真正的 superuser,見 `k8s/README.md` 說明)
- Migration 檔案透過內容雜湊過的 ConfigMap 送進去(而不是烤進 image 裡)
- `backoffLimit: 0` —— DDL 遷移半套用失敗時,應該讓人介入處理,而不是被排程器安靜地自動重跑

```bash
kubectl wait --for=condition=complete job/db-migrate-shop-sync-<hash> --timeout=900s -n <namespace>
kubectl logs job/db-migrate-shop-sync-<hash> -n <namespace>
```

正式對 production 跑之前,先過一遍 [docs/DDL-PRODUCTION-SAFETY.md](docs/DDL-PRODUCTION-SAFETY.md) 第 5 節的檢查清單。完整工作流程見 [`k8s/README.md`](k8s/README.md)。

---

## 疑難排解

**Windows 上 Docker Desktop 起不來 / `docker ps` 連不到引擎**
Docker Desktop 在 Windows Home 上依賴 WSL2 才能跑它的 Linux 引擎。以系統管理員身分執行 `wsl --install`,重開機,再啟動 Docker Desktop。

**跑 DCL 時看到 `⚠️ Lock wait timeout (attempt N/3), retrying...`**
這是正常的保護機制,不是錯誤 —— 代表這個 `ALTER TABLE` 卡在別的長交易的 metadata lock 後面,guard 正在照設定重試,重試次數用完才會真的失敗。細節見 [docs/LOCK-GUARD.md](docs/LOCK-GUARD.md)。

**在原生 Windows 直接跑 `node src/cli.js dcl` 出現 `ENOENT ... open 'C:\tmp\secret'`**
DCL 產生的密碼固定寫到 `/tmp/secret`,這是為 Linux/容器部署設計的路徑約定(見 [docs/DCL-PASSWORD.md](docs/DCL-PASSWORD.md))。在原生 Windows 上這個路徑不存在。解法:一律透過 `docker compose run --rm migrate dcl ...` 執行 DCL 相關指令,而不是在 Windows 主機上直接跑。

---

## 📖 完整文件

指令選項、設定檔格式、驗證規則等完整參考請看 [README.md](README.md),或直接查閱 [docs/](./docs/) 目錄下的細節文件,例如 [docs/DOCKER-USAGE.md](./docs/DOCKER-USAGE.md)。
