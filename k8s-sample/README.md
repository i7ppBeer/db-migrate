# K8s Sample — Minikube 部署範例

在本地 minikube 上示範完整的 DB migration 流程：  
**Build Image → 部署 MariaDB & MongoDB → 用 Helm Chart 執行 DDL Migration**

## 目錄結構

```
k8s-sample/
├── README.md              ← 本文件
├── setup.sh               ← 一鍵安裝（minikube + DB + migration）
├── cleanup.sh             ← 一鍵清理
├── values-mariadb.yaml    ← MariaDB DDL migration values（3 筆 SQL）
└── values-mongodb.yaml    ← MongoDB DDL migration values（2 筆 JS）
```

## 前置需求

| 工具 | 用途 |
|------|------|
| [Docker](https://docs.docker.com/get-docker/) | 建 image + minikube driver |
| [minikube](https://minikube.sigs.k8s.io/docs/start/) | 本地 K8s cluster |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | K8s CLI |
| [Helm](https://helm.sh/docs/intro/install/) | 部署 Chart |

## 快速開始

### 一鍵執行

```bash
bash k8s-sample/setup.sh
```

此腳本會依序：

1. 檢查 docker / minikube / helm / kubectl
2. 啟動 minikube（Docker driver, 4GB RAM, 2 CPU）
3. Build `db-migrate:3.0.0` 並載入 minikube
4. 部署 MariaDB（Bitnami）+ MongoDB（Bitnami）
5. `helm install mariadb-ddl` — 執行 3 筆 MariaDB schema migration
6. `helm install mongodb-ddl` — 執行 2 筆 MongoDB schema migration

### 手動執行（逐步）

```bash
# 1. 啟動 minikube
minikube start --driver=docker --memory=4096 --cpus=2

# 2. Build image & 載入
docker build -t db-migrate:3.0.0 .
minikube image load db-migrate:3.0.0

# 3. 建立 namespace + 部署 DB
kubectl create namespace db-migrate

helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

helm install mariadb bitnami/mariadb -n db-migrate \
  --set auth.rootPassword=rootpass \
  --set auth.database=migrate_test \
  --set auth.username=migrate \
  --set auth.password=migratepass \
  --set primary.persistence.size=1Gi \
  --wait --timeout 3m

helm install mongodb bitnami/mongodb -n db-migrate \
  --set auth.enabled=false \
  --set persistence.size=1Gi \
  --wait --timeout 3m

# 4. 等 DB ready
kubectl -n db-migrate wait --for=condition=ready pod -l app.kubernetes.io/name=mariadb --timeout=120s
kubectl -n db-migrate wait --for=condition=ready pod -l app.kubernetes.io/name=mongodb --timeout=120s

# 5. 執行 MariaDB DDL migration
helm install mariadb-ddl ./charts/db-migrate -n db-migrate \
  -f k8s-sample/values-mariadb.yaml --timeout 5m

# 6. 執行 MongoDB DDL migration
helm install mongodb-ddl ./charts/db-migrate -n db-migrate \
  -f k8s-sample/values-mongodb.yaml --timeout 5m
```

## 觀察結果

```bash
# 查看所有 pods
kubectl -n db-migrate get pods

# 查看 migration jobs
kubectl -n db-migrate get jobs

# 查看 migration logs
kubectl -n db-migrate logs -l app.kubernetes.io/component=ddl
```

### 預期輸出

**MariaDB DDL Job（~6s）：**

```
✅ Applied 3 migration(s):
   20250101000001-create-users.sql
   20250101000002-seed-users.sql
   20250101000003-create-products.sql
```

**MongoDB DDL Job（~7s）：**

```
✅ Applied 2 migration(s):
   20250101000001-create-users.js
   20250101000002-create-products.js
```

## Helm Chart 執行流程

```
helm install
  │
  ├─ hook-weight: -15  →  ServiceAccount
  ├─ hook-weight: -10  →  ConfigMap（DDL migration 檔案）
  └─ hook-weight: -3   →  Job（執行 entrypoint.sh → up）
                              │
                              ├─ wait_for_database()
                              ├─ generate_config()    →  /app/config/config.js
                              └─ node cli.js up       →  讀取 /app/migrations/
```

## Values 說明

### MariaDB (`values-mariadb.yaml`)

| Key | 值 | 說明 |
|-----|-----|------|
| `mode` | `job` | Helm hook Job，install/upgrade 時自動執行 |
| `mariadb.host` | `mariadb` | Bitnami MariaDB service name |
| `ddl.user` | `root` | DDL 通常需要 schema 權限 |
| `ddl.existingSecret` | `mariadb` | Bitnami 自動建立的 Secret |
| `ddl.secretKey` | `mariadb-root-password` | Secret 中密碼的 key |
| `ddl.files` | 3 筆 `.sql` | 直接嵌入 values，自動建為 ConfigMap |

### MongoDB (`values-mongodb.yaml`)

| Key | 值 | 說明 |
|-----|-----|------|
| `mode` | `job` | 同上 |
| `mongodb.host` | `mongodb` | Bitnami MongoDB service name |
| `mongodb.auth.enabled` | `false` | 範例簡化，不開認證 |
| `ddl.files` | 2 筆 `.js` | ESM 格式，export `up()` / `down()` |

### image.pullPolicy: Never

minikube 不從 registry 拉取，而是用 `minikube image load` 直接載入本地 image，所以設 `Never`。正式環境應改為 `IfNotPresent` 或 `Always`。

## 重跑 Migration

```bash
# 先 uninstall 再 install（hook 會重新執行）
helm uninstall mariadb-ddl -n db-migrate
helm install mariadb-ddl ./charts/db-migrate -n db-migrate \
  -f k8s-sample/values-mariadb.yaml --timeout 5m

# 或用 upgrade --install（hook 也會重新觸發）
helm upgrade --install mariadb-ddl ./charts/db-migrate -n db-migrate \
  -f k8s-sample/values-mariadb.yaml --timeout 5m
```

## 清理

```bash
# 一鍵清理
bash k8s-sample/cleanup.sh

# 或手動
helm uninstall mariadb-ddl mongodb-ddl mongodb mariadb -n db-migrate
kubectl delete namespace db-migrate
minikube stop
```

## 切換為 Deployment 模式

如果想用 `kubectl exec` 手動操作，改 `mode: deployment`：

```bash
helm install mariadb-ddl ./charts/db-migrate -n db-migrate \
  -f k8s-sample/values-mariadb.yaml \
  --set mode=deployment --timeout 5m

# exec 進去執行
kubectl -n db-migrate exec -it deploy/mariadb-ddl-db-migrate-ddl -- bash
# 在容器內：
#   node src/cli.js status -c /app/config/config.js
#   node src/cli.js down -n 1 -c /app/config/config.js
```
