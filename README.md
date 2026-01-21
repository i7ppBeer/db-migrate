# DB-Migrate v2.0

> 統一的多資料庫遷移管理工具，支援 MongoDB 與 MariaDB/MySQL，包含多實例同步測試

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](package.json)

## 🎯 特點

- **多資料庫支援**: MongoDB (via migrate-mongo) 和 MariaDB/MySQL (sql-migrate 模式)
- **多實例支援**: 同時管理多個資料庫實例 (如 primary/secondary/tertiary)
- **統一 CLI**: 單一命令行界面管理所有資料庫遷移
- **驗證規則**: 自動檢測危險操作、空 down()、孤立 drop、DCL 操作等問題
- **Up-Down-Up 測試**: 確保遷移可以正確回滾和重新應用
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
node src/cli.js -c databases/mongodb/test-success/config.js status

# MongoDB 範例 - 執行遷移
node src/cli.js -c databases/mongodb/test-success/config.js up

# MariaDB 範例 - 查看狀態
node src/cli.js -c databases/mariadb/test-success/config.js status

# MariaDB 範例 - 執行遷移
node src/cli.js -c databases/mariadb/test-success/config.js up
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
  changelogCollectionName: 'changelog'
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
      changelogCollectionName: 'changelog'
    },
    {
      name: 'mongo-secondary',
      mongodb: {
        url: 'mongodb://localhost:27017',
        databaseName: 'app_secondary'
      },
      changelogCollectionName: 'changelog'
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

### 🔷 CLI 指令詳解

#### 1. 查看遷移狀態 (`status`)

```bash
# 基本用法
node src/cli.js -c <config-path> status

# 範例
node src/cli.js -c databases/mongodb/test-success/config.js status
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
node src/cli.js -c databases/mongodb/test-success/config.js up
node src/cli.js -c databases/mariadb/test-success/config.js up --dry-run
node src/cli.js -c databases/mongodb/test-success/config.js up --sanity-check
```

#### 3. 回滾遷移 (`down`)

```bash
# 回滾最後一個遷移
node src/cli.js -c <config-path> down

# 回滾指定數量的遷移
node src/cli.js -c <config-path> down -n <count>

# 範例
node src/cli.js -c databases/mongodb/test-success/config.js down -n 1
node src/cli.js -c databases/mongodb/test-success/config.js down -n 3
```

#### 4. 建立新遷移 (`create`)

```bash
# 建立新遷移檔案
node src/cli.js -c <config-path> create <migration-name>

# 範例
node src/cli.js -c databases/mongodb/test-success/config.js create add-user-avatar
node src/cli.js -c databases/mariadb/test-success/config.js create create-orders-table
```

輸出：
```
✅ Created: 20250120123456-add-user-avatar.js

Remember to:
1. Implement the UP section
2. Implement the DOWN section
3. Run validation: db-migrate validate -c <config>
```

#### 5. 驗證遷移檔案 (`validate`)

```bash
# 驗證所有遷移檔案
node src/cli.js -c <config-path> validate

# 允許危險操作（顯示為警告而非錯誤）
node src/cli.js -c <config-path> validate --allow-dangerous

# 範例
node src/cli.js -c databases/mongodb/test-success/config.js validate
node src/cli.js -c databases/mongodb/test-failure/config.js validate
```

輸出範例：
```
[VALIDATE] Checking migrations (mongodb)...

[OK] 20250101000001-create-users.js
[OK] 20250101000002-seed-users.js
[ERROR] 20250101000003-dangerous-drop-database.js
   ❌ Dangerous operation: dropDatabase is not allowed

──────────────────────────────────────────────────
Total: 3 file(s)
Valid: 2
Invalid: 1
```

#### 6. Up-Down-Up 測試 (`test`)

```bash
# 執行單一實例的 Up-Down-Up 測試
node src/cli.js -c <config-path> test

# 範例
node src/cli.js -c databases/mongodb/test-success/config.js test
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
node src/cli.js -c databases/mongodb/multi-instance/config.js test-instances
```

#### 8. 查看所有實例狀態 (`status-all`)

```bash
# 查看所有實例的遷移狀態
node src/cli.js -c <config-path> status-all

# 範例
node src/cli.js -c databases/mongodb/multi-instance/config.js status-all
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
node src/cli.js -c databases/mongodb/multi-instance/config.js up-all
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

### 🔷 實用範例

#### 開發環境工作流程

```bash
# 1. 啟動資料庫
docker compose up -d mongodb mariadb

# 2. 建立新遷移
node src/cli.js -c databases/mongodb/test-success/config.js create add-user-roles

# 3. 編輯遷移檔案（實現 up/down 函數）

# 4. 驗證遷移
node src/cli.js -c databases/mongodb/test-success/config.js validate

# 5. 執行遷移（先 dry-run）
node src/cli.js -c databases/mongodb/test-success/config.js up --dry-run

# 6. 正式執行
node src/cli.js -c databases/mongodb/test-success/config.js up

# 7. 測試回滾
node src/cli.js -c databases/mongodb/test-success/config.js test
```

#### CI/CD 整合

```bash
# 在 CI pipeline 中驗證所有遷移
node src/cli.js -c databases/mongodb/test-success/config.js validate || exit 1

# 執行完整測試
node src/cli.js -c databases/mongodb/test-success/config.js test || exit 1

# 部署時執行遷移
node src/cli.js -c databases/mongodb/test-success/config.js up
```

#### 多環境部署

```bash
# 使用環境變數切換環境
MONGO_URL=mongodb://prod-server:27017 \
MONGO_DB=production_db \
node src/cli.js -c databases/mongodb/test-success/config.js up

# 或建立環境特定配置
node src/cli.js -c databases/mongodb/production/config.js status
node src/cli.js -c databases/mongodb/staging/config.js up
```

---

## 📁 專案結構

```
db-migrate/
├── src/
│   ├── cli.js                   # 統一 CLI 入口
│   ├── core/
│   │   ├── base-adapter.js      # 適配器基類
│   │   ├── reporter.js          # 報表生成器
│   │   └── sanity-checker.js    # Sanity Check 框架
│   └── adapters/
│       ├── index.js             # 適配器工廠
│       ├── mongodb-adapter.js   # MongoDB 適配器
│       └── mariadb-adapter.js   # MariaDB 適配器
├── databases/
│   ├── mongodb/
│   │   ├── test-success/        # MongoDB 成功案例
│   │   ├── test-failure/        # MongoDB 失敗案例（驗證測試）
│   │   └── multi-instance/      # MongoDB 多實例範例
│   └── mariadb/
│       ├── test-success/        # MariaDB 成功案例
│       ├── test-failure/        # MariaDB 失敗案例（驗證測試）
│       └── multi-instance/      # MariaDB 多實例範例
├── charts/
│   └── db-migrate/              # Helm Chart
├── docker/
│   └── entrypoint.sh            # Docker 入口腳本
├── scripts/
│   ├── setup-k8s-dev.sh         # K8s 開發環境設定
│   └── run-tests.sh             # 測試執行腳本
├── Dockerfile                   # 多階段 Dockerfile
└── docker-compose.yml           # 開發環境 Compose
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
node src/cli.js -c databases/mongodb/test-success/config.js validate
node src/cli.js -c databases/mariadb/test-success/config.js validate

# 執行危險操作檢測測試（應該失敗）
node src/cli.js -c databases/mongodb/test-failure/config.js validate
node src/cli.js -c databases/mariadb/test-failure/config.js validate

# 執行 Up-Down-Up 測試
node src/cli.js -c databases/mongodb/test-success/config.js test
node src/cli.js -c databases/mariadb/test-success/config.js test

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
# 基本部署
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=false \
  --set mariadb.enabled=true \
  --set mariadb.host=mariadb.default.svc.cluster.local \
  --set mariadb.database=myapp \
  --set mariadb.user=migrate \
  --set mariadb.password=secret

# 使用 existing Secret
helm upgrade --install my-migration ./charts/db-migrate \
  --set mongodb.enabled=false \
  --set mariadb.enabled=true \
  --set mariadb.host=mariadb \
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

#### 使用 ConfigMap 載入遷移

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

- [遷移管理指南](docs/MIGRATION-MANAGEMENT-GUIDE.md)
- [AWS 風格發布公告](docs/MIGRATION-MANAGEMENT-GUIDE-AWS-STYLE.md)
- [Helm Chart Values 說明](charts/db-migrate/values.yaml)

---

## 📝 License

MIT License
