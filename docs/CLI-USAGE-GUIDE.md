# 資料庫遷移操作指南

## 目錄結構

```
test-fixtures/
├── mariadb/
│   ├── production-server/
│   │   ├── ddl/                 # DDL (版本化遷移)
│   │   │   ├── config.js
│   │   │   └── migrations/
│   │   └── dcl/                 # DCL (可重複遷移)
│   │       ├── config.js
│   │       └── migrations/
│   ├── test-success/
│   │   ├── ddl/
│   │   └── dcl/
│   ├── test-failure/
│   │   ├── ddl/
│   │   └── dcl/
│   └── multi-instance/          # 多資料庫實例
│       ├── config.js
│       └── migrations/
└── mongodb/
    └── (同上結構)
```

## 基本指令

### 1. 查看遷移狀態

```bash
# 查看 MariaDB DDL 遷移狀態
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status

# 查看 MongoDB DDL 遷移狀態
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js status
```

### 2. 執行遷移 (UP)

```bash
# 執行所有待定遷移
node src/cli.js -c <config-path> up

# 模擬執行（不真正執行）
node src/cli.js -c <config-path> up --dry-run

# 啟用 Sanity Check（自動回滾失敗的遷移）
node src/cli.js -c <config-path> up --sanity-check

# 禁用自動回滾
node src/cli.js -c <config-path> up --sanity-check --no-auto-rollback
```

### 3. 回滾遷移 (DOWN)

```bash
# 回滾最後一個遷移
node src/cli.js -c <config-path> down

# 回滾最後 N 個遷移
node src/cli.js -c <config-path> down -n 3
```

### 4. 重置遷移紀錄 (RESET)

刪除 changelog（DDL）或 checksum（DCL）table/collection 裡**所有**紀錄，讓下一次 `status`/`up`/`dcl` 把所有遷移都當成 pending。**不會**執行 `down()`，也**不會**動到實際的表格/collection 或資料 —— 只清工具自己的追蹤紀錄。

```bash
# 預設是 dry-run：只印出會刪幾筆，不會真的刪
node src/cli.js -c <config-path> reset

# 加 --yes 才會真的執行刪除
node src/cli.js -c <config-path> reset --yes
```

⚠️ 只清紀錄、不清實際資料，代表重置後再跑 `up` 極可能因為表格/collection 已存在而失敗（除非migration 本身有用 `IF NOT EXISTS`）。**通常只在會被整個重置的開發/測試用資料庫上使用**，正式環境幾乎不會需要。

---

## 🎯 指定特定遷移

### --target：執行到指定遷移（包含）

執行從第一個待定遷移到指定遷移的所有遷移。

```bash
# 執行到 create-orders（包含 create-users, seed-users, create-products, create-orders）
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target 20250101000004-create-orders.sql

# 支援部分匹配（只要名稱包含即可）
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target create-orders

# MongoDB 範例
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up --target seed-users
```

### --only：只執行指定的單一遷移

只執行特定的一個遷移（必須在待定列表中）。

```bash
# 只執行 add-user-profile
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only 20250101000005-add-user-profile.sql

# 支援部分匹配
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only add-user-profile

# MongoDB 範例
node src/cli.js -c test-fixtures/mongodb/test-success/ddl/config.js up --only create-products
```

### 組合使用範例

```bash
# 先檢查狀態
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js status

# 結果：
# ✅ Applied (2):
#    20250101000001-create-users.sql
#    20250101000002-seed-users.sql
# ⏳ Pending (4):
#    20250101000003-create-products.sql
#    20250101000004-create-orders.sql
#    20250101000005-add-user-profile.sql
#    20250101000006-add-phone-with-sanity.sql

# 只執行到 create-orders（執行 products 和 orders）
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --target create-orders

# 跳過 add-user-profile，只執行 add-phone-with-sanity
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js up --only add-phone-with-sanity
```

---

## 🔄 多資料庫實例

### 設定檔範例 (multi-instance/config.js)

```javascript
export default {
  type: 'mariadb',
  migrationsDir: './migrations',
  changelogTable: '_migrations',
  
  instances: [
    {
      name: 'primary-db',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_primary',
        user: 'root',
        password: 'password'
      }
    },
    {
      name: 'secondary-db',
      mariadb: {
        host: 'localhost',
        port: 3306,
        database: 'app_secondary',
        user: 'root',
        password: 'password'
      }
    }
  ]
};
```

### 多實例指令

```bash
# 測試所有實例（驗證 + Up-Down-Up 測試）
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances

# 只驗證，不執行遷移測試
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances --validate-only

# 平行執行（更快但更耗資源）
node src/cli.js -c test-fixtures/mariadb/multi-instance/config.js test-instances --parallel
```

---

## 🔍 驗證遷移

### 驗證遷移檔案的安全性

```bash
# 驗證 DDL 遷移（檢查危險操作、DCL 混用等）
node src/cli.js -c test-fixtures/mariadb/test-success/ddl/config.js validate

# 驗證失敗案例（應該報錯）
node src/cli.js -c test-fixtures/mariadb/test-failure/ddl/config.js validate
```

驗證會檢查：
- 🔴 **禁止操作**：DROP DATABASE、使用者管理（應在 DCL）
- 🟠 **危險操作**：TRUNCATE、DROP TABLE（無對應 CREATE）
- 🟡 **警告提示**：可能影響效能的操作

---

## 📊 CI/CD 測試流程

### 完整 CI 測試（Up → Down → Up）

```bash
# 1. 重置資料庫
docker exec test-mariadb mariadb -uroot -prootpass -e "DROP DATABASE IF EXISTS test_db; CREATE DATABASE test_db;"

# 2. 檢查初始狀態
node src/cli.js -c <config> status

# 3. 執行 UP
node src/cli.js -c <config> up

# 4. 執行 DOWN
node src/cli.js -c <config> down

# 5. 再次執行 UP
node src/cli.js -c <config> up

# 6. 檢查最終狀態
node src/cli.js -c <config> status
```

### 使用測試指令

```bash
# 自動執行完整測試流程（單一資料庫）
node src/cli.js -c <config> test

# 多實例測試
node src/cli.js -c <config> test-instances
```

---

## 📁 常用配置路徑

| 類型 | 路徑 |
|------|------|
| MariaDB DDL 成功案例 | `test-fixtures/mariadb/test-success/ddl/config.js` |
| MariaDB DCL 成功案例 | `test-fixtures/mariadb/test-success/dcl/config.js` |
| MariaDB DDL 失敗案例 | `test-fixtures/mariadb/test-failure/ddl/config.js` |
| MariaDB 多實例 | `test-fixtures/mariadb/multi-instance/config.js` |
| MongoDB DDL 成功案例 | `test-fixtures/mongodb/test-success/ddl/config.js` |
| MongoDB DCL 成功案例 | `test-fixtures/mongodb/test-success/dcl/config.js` |
| MongoDB 多實例 | `test-fixtures/mongodb/multi-instance/config.js` |

---

## 🐳 Docker 測試環境

### 啟動測試資料庫

```bash
# 啟動 MongoDB 和 MariaDB
docker compose -f docker-compose.local-test.yml up -d mongodb mariadb

# 檢查狀態
docker compose -f docker-compose.local-test.yml ps

# 查看日誌
docker compose -f docker-compose.local-test.yml logs -f
```

### 資料庫連線資訊

| 資料庫 | Host | Port | User | Password | Database |
|--------|------|------|------|----------|----------|
| MariaDB | localhost | 3306 | root | rootpass | test_* |
| MongoDB | localhost | 27017 | - | - | test_* |

---

## ⚠️ 注意事項

1. **DDL vs DCL 分離**：
   - DDL（Data Definition Language）：CREATE TABLE, ALTER TABLE 等結構變更
   - DCL（Data Control Language）：CREATE USER, GRANT 等權限管理
   - DCL 應使用 Repeatable 模式，檔案命名為 `R__xxx.sql`

2. **--only 限制**：
   - 只能執行**待定列表**中的遷移
   - 如果遷移已執行過，需要先 down 再 up

3. **多實例注意**：
   - 所有實例共用相同的遷移檔案
   - 每個實例有獨立的 changelog 表

4. **`reset` 只清紀錄、不清資料**：
   - 只刪 changelog/checksum 裡的追蹤紀錄，不執行 `down()`、不動實際表格/collection
   - 重置後跑 `up` 若表格/collection 已存在（沒有 `IF NOT EXISTS`）會直接失敗
   - 預設 dry-run，需要 `--yes` 才會真的刪除
