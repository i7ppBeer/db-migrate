# MongoDB Migration Management System

[DEPLOY] 企業級 MongoDB 資料庫遷移管理系統，支援多資料庫、版本控制、自動化測試與 Kubernetes 部署。

## ✨ 核心功能

- **多資料庫管理** - 同時管理多個獨立的 MongoDB 資料庫
- **版本控制** - 時間戳記式 migration 文件，完整追蹤歷史
- **安全驗證** - 防止危險操作（刪除資料庫、建立用戶等）
- **自動化測試** - Docker 容器測試，支援 MongoDB 6.0/7.0/8.0
- **Kubernetes 部署** - 生產環境就緒的 K8s manifests
- **自動回滾** - 部署失敗自動復原

## 📋 系統需求

- Node.js >= 20.0.0
- Docker（本地測試）
- Kubernetes（生產部署）
- MongoDB 6.0/7.0/8.0

---

## [DEPLOY] 快速開始

### 1. 安裝

```bash
git clone <your-repo-url>
cd mongodb-migrate
npm install
npm run init
```

### 2. 單一資料庫配置

**方式 A: 環境變數**（推薦 K8s）
```bash
export MONGODB_URL="mongodb://user:pass@host:27017"
export MONGODB_DATABASE="your_database"
```

**方式 B: 編輯 migrate-mongo-config.js**
```javascript
mongodb: {
  url: "mongodb://localhost:27017",
  databaseName: "my_database"
}
```

### 3. 多資料庫配置 (推薦結構)

建議採用以下目錄結構管理多個資料庫：

```
repo/
  databases/
    users/
      config.js
      migrations/
    products/
      config.js
      migrations/
```

**配置檔範例 (databases/users/config.js):**

```javascript
export default {
  mongodb: {
    url: process.env.USERS_DB_URL || "mongodb://localhost:27017",
    databaseName: process.env.USERS_DB_NAME || "users_db"
  },
  // 相對路徑，指向同目錄下的 migrations 資料夾
  migrationsDir: "migrations", 
  changelogCollectionName: "changelog"
};
```

使用配置檔執行：
```bash
# 操作 Users 資料庫
node src/cli.js --config databases/users/config.js up

# 操作 Products 資料庫
node src/cli.js --config databases/products/config.js up
```

### 4. 建立 Migration

```bash
# 指定設定檔來建立 Migration
node src/cli.js create "add user index" -c databases/users/config.js
```

Migration 範例：
```javascript
export async function up(db, client) {
  await db.collection('users').createIndex(
    { email: 1 }, 
    { unique: true, background: true }
  );
}

export async function down(db, client) {
  await db.collection('users').dropIndex('email_1');
}
```

### 5. 執行 Migration

```bash
# 檢查狀態
npm run status

# 執行遷移
npm run up

# 回滾
npm run down

# 多資料庫
node src/cli.js --config config/my-users-db.js status
node src/cli.js --config config/my-users-db.js up
```

---

## [INIT] 多資料庫批次執行

批次執行所有資料庫的 migrations：

```bash
bash scripts/migrate-all-databases.sh
```

此腳本會自動：
- 掃描 `config/` 目錄中所有配置檔
- 依序執行每個資料庫的 migration
- 顯示執行結果摘要

---

## [OK] 驗證與測試

### 本地驗證

```bash
# 驗證所有 migrations
npm run validate

# 驗證特定檔案
npm run validate -- --file migrations/20240101120000-add-user-index.js

```

### Docker 容器測試

```bash
# Container 測試（單一版本）
npm run test:local

# 完整測試（多版本：6.0, 7.0, 8.0）
MIN_VERSION=6.0 MAX_VERSION=8.0 ./scripts/docker-test.sh
```

測試場景：
- [OK] MongoDB 6.0 遷移測試
- [OK] MongoDB 8.0 遷移測試
- [OK] 升級路徑測試（6.0 → 8.0）
- [OK] 回滾測試（up → down → up）

---

## ☸️ Kubernetes 部署

### 快速部署（3 步驟）

**步驟 1: 建立 Namespace**
```bash
kubectl apply -f k8s/namespace.yaml
```

**步驟 2: 建立 Secret**
```bash
kubectl create secret generic mongodb-credentials \
  --from-literal=MONGODB_URL='mongodb://user:pass@mongodb:27017' \
  --from-literal=MONGODB_DATABASE='your_db' \
  -n mongodb-migrations
```

**步驟 3: 執行部署**
```bash
./scripts/k8s-deploy.sh
# 或
npm run k8s:deploy
```

### K8s 多資料庫部署

修改 `k8s/migration-job.yaml`，為每個資料庫建立不同的 Job：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: mongodb-migration-users
spec:
  template:
    spec:
      containers:
      - name: migration
        image: node:20-alpine
        command: ["node", "src/cli.js", "--config", "config/my-users-db.js", "up"]
        env:
        - name: USERS_DB_URL
          valueFrom:
            secretKeyRef:
              name: mongodb-credentials
              key: USERS_DB_URL
```

### 手動回滾

```bash
kubectl apply -f k8s/rollback-job.yaml
kubectl logs -f job/mongodb-rollback -n mongodb-migrations
```

---

## 🔒 安全驗證規則

### 預設禁止操作

系統會自動阻擋以下危險操作：
- `dropDatabase` - 刪除資料庫
- `createUser` / `dropUser` - 用戶管理
- `updateUser` - 更新用戶
- 直接修改系統集合

### 自訂驗證規則

編輯 `src/config/validation-rules.js`：

```javascript
export const validationRules = {
  forbidden: {
    database: ['dropDatabase', 'createUser'],
    collection: ['drop'] // 禁止 collection.drop()
  },
  custom: [
    {
      name: 'requireIndexBackground',
      message: '所有索引必須指定 background 選項',
      check: (content) => {
        const hasCreateIndex = content.includes('createIndex');
        const hasBackground = content.includes('background:');
        return !hasCreateIndex || hasBackground;
      }
    }
  ]
};
```

---

## 📁 專案結構

```
mongodb-migrate/
├── config/                      # 多資料庫配置檔
│   ├── example-app-users.js     # Users DB 配置
│   ├── example-app-orders.js    # Orders DB 配置
│   └── example-app-analytics.js # Analytics DB 配置
├── migrations/                  # Migration 檔案
│   ├── users/                   # Users DB migrations
│   ├── orders/                  # Orders DB migrations
│   └── analytics/               # Analytics DB migrations
├── k8s/                         # Kubernetes manifests
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── migration-job.yaml
│   └── rollback-job.yaml
├── scripts/
│   ├── docker-test.sh           # Docker 測試腳本
│   ├── k8s-deploy.sh            # K8s 部署腳本
│   ├── migrate-all-databases.sh # 批次執行腳本
│   └── k8s-multi-db-runner.sh   # K8s 多資料庫測試
├── src/
│   ├── cli.js                   # CLI 介面
│   ├── config/
│   │   └── validation-rules.js  # 驗證規則
│   ├── validators/
│   │   └── mql-validator.js     # MQL 驗證器
│   └── testers/
│       └── migration-tester.js  # 測試工具
└── migrate-mongo-config.js      # 預設配置
```

---

## 🛠️ 常用指令

### 基本操作
```bash
npm run init                 # 初始化專案
npm run create "說明"        # 建立 migration
npm run status              # 查看狀態
npm run up                  # 執行遷移
npm run down                # 回滾
```

### 多資料庫操作
```bash
node src/cli.js --config config/my-db.js create "說明"
node src/cli.js --config config/my-db.js status
node src/cli.js --config config/my-db.js up
bash scripts/migrate-all-databases.sh
```

### 測試與驗證
```bash
npm run validate            # 驗證 migrations
npm run test:local          # 本地測試
./scripts/docker-test.sh    # Docker 完整測試
```

### Kubernetes
```bash
npm run k8s:deploy          # 部署到 K8s
kubectl get jobs -n mongodb-migrations
kubectl logs -f job/mongodb-migration -n mongodb-migrations
```

---

## 📊 實際使用範例

### 範例 1: 單一資料庫

```bash
# 1. 建立 migration
npm run create "add email index to users"

# 2. 編輯檔案 migrations/20250123120000-add-email-index-to-users.js
# 3. 驗證
npm run validate

# 4. 測試
npm run test:local

# 5. 執行
npm run up
```

### 範例 2: 多資料庫專案

```bash
# 1. 建立配置檔
# config/prod-users.js
# config/prod-orders.js

# 2. 分別建立 migrations
node src/cli.js --config config/prod-users.js create "add user profile"
node src/cli.js --config config/prod-orders.js create "add order status"

# 3. 批次執行所有資料庫
bash scripts/migrate-all-databases.sh

# 4. 檢查各資料庫狀態
node src/cli.js --config config/prod-users.js status
node src/cli.js --config config/prod-orders.js status
```

### 範例 3: K8s 部署多資料庫

```bash
# 1. 建立不同的 secrets
kubectl create secret generic users-db-creds \
  --from-literal=USERS_DB_URL='mongodb://...' \
  -n mongodb-migrations

kubectl create secret generic orders-db-creds \
  --from-literal=ORDERS_DB_URL='mongodb://...' \
  -n mongodb-migrations

# 2. 部署各資料庫的 Job
kubectl apply -f k8s/migration-job-users.yaml
kubectl apply -f k8s/migration-job-orders.yaml

# 3. 監控執行
kubectl get jobs -n mongodb-migrations
kubectl logs -f job/mongodb-migration-users -n mongodb-migrations
```

---

## 🐛 疑難排解

### Migration 在 K8s 失敗

```bash
# 檢查 Job 狀態
kubectl get jobs -n mongodb-migrations

# 查看日誌
kubectl logs -l app=mongodb-migration -n mongodb-migrations

# 檢查詳細資訊
kubectl describe job mongodb-migration -n mongodb-migrations

# 刪除失敗的 Job 重新執行
kubectl delete job mongodb-migration -n mongodb-migrations
kubectl apply -f k8s/migration-job.yaml
```

### Docker 測試失敗

```bash
# 清理容器
docker stop $(docker ps -a -q --filter name=mongo-test)
docker rm $(docker ps -a -q --filter name=mongo-test)

# 重新執行
./scripts/docker-test.sh
```

### 多資料庫配置問題

```bash
# 檢查配置是否正確載入
node -e "import('./config/my-db.js').then(c => console.log(c))"

# 測試環境變數
export MY_DB_URL="mongodb://localhost:27017"
export MY_DB_NAME="test_db"
node src/cli.js --config config/my-db.js status
```

---

## 🎯 最佳實踐

1. **環境隔離** - 使用不同的 config 區分開發/測試/生產
2. **版本控制** - 所有 migrations 納入 Git 版控
3. **測試優先** - 生產部署前務必在 Docker/Staging 測試
4. **備份習慣** - 執行遷移前先備份資料庫
5. **漸進部署** - 大型變更分批多次 migration
6. **文件記錄** - 在 migration 中加入清楚的註解
7. **Secret 管理** - 使用 K8s Secrets，絕不提交密碼到 Git

---

## 📄 授權

MIT License

---

## 🙏 致謝

基於 [migrate-mongo](https://github.com/seppevs/migrate-mongo) 建立。
