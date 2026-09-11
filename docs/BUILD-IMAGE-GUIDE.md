# Build Image 部署遷移檔案指南

> ⚠️ **部分過期（2026-09-11 稽核，Kubernetes 章節已修正）**：
> - **Kubernetes 部署**章節已改成指向真正存在、可用的 [`k8s/`](../k8s/README.md)（kubectl + ConfigMap/Secret/Job），原本教的 `./charts/db-migrate` Helm chart從來沒被建立過。
> - **Azure DevOps Pipeline** 章節提到的 `azure-pipelines-migrations.yml` 仍然**不存在**（`Dockerfile.azure` 倒是真的存在，是給 Azure DevOps agent 用的 image）——這節內容未經驗證，先當作草稿看待，要用的話得自己補上實際的 pipeline YAML。
> - `.github/workflows/migrations.yml` 已同步修正（原本 build/deploy job 也引用了不存在的 `Dockerfile.migrations` 和 Helm chart）。

本指南說明如何透過 Build Image 方式將 DDL 遷移檔案部署到 Kubernetes 生產環境。

## 目錄

1. [流程概覽](#流程概覽)
2. [本地建置](#本地建置)
3. [CI/CD 自動化](#cicd-自動化)
4. [Kubernetes 部署](#kubernetes-部署)
5. [最佳實踐](#最佳實踐)

---

## 流程概覽

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Production 部署流程                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Developer         CI/CD              Staging        Production    │
│      │                │                   │               │         │
│      │  1. 新增遷移檔案並 commit           │               │         │
│      │───────────────>│                   │               │         │
│      │                │                   │               │         │
│      │                │  2. 自動測試 & 驗證              │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │  3. Build Image (v1.2.3)         │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │  4. 自動部署到 Staging            │         │
│      │                │──────────────────>│               │         │
│      │                │                   │               │         │
│      │                │                   │  5. 測試驗證  │         │
│      │                │                   │──────>│       │         │
│      │                │                   │       │ OK    │         │
│      │                │                   │<──────│       │         │
│      │                │                   │               │         │
│      │                │  6. 手動審批後部署 Production      │         │
│      │                │──────────────────────────────────>│         │
│      │                │                   │               │         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 專案結構

```
your-project/
├── migrations/                    # ✅ 遷移檔案目錄 (打包進 Image)
│   ├── 20250101000001-create-users.js
│   ├── 20250101000002-seed-users.js
│   └── 20250120000001-add-new-column.js  ← 新增的 DDL
├── src/                           # 遷移工具原始碼
├── charts/db-migrate/             # Helm Chart
├── Dockerfile                     # 基礎映像
├── Dockerfile.migrations          # 遷移映像 (包含遷移檔案)
├── scripts/
│   └── build-migration-image.sh   # 建置腳本
├── azure-pipelines-migrations.yml # Azure DevOps Pipeline
└── .github/workflows/migrations.yml # GitHub Actions
```

---

## 本地建置

### 快速開始

```bash
# 1. 新增遷移檔案
vim migrations/20250120000001-add-user-status.js

# 2. 建置映像
./scripts/build-migration-image.sh -t v1.0.0

# 3. 驗證映像
docker run --rm db-migrate:v1.0.0 --help
```

### 建置腳本參數

```bash
./scripts/build-migration-image.sh [options]

Options:
  -t, --tag          Image tag (default: latest)
  -r, --registry     Registry URL
  -m, --migrations   Migrations directory (default: ./migrations)
  -b, --base         Base image (default: db-migrate:2.0.0)
  -p, --push         Push to registry after build
  -h, --help         Show help
```

### 建置範例

```bash
# 建置並推送到 Azure Container Registry
./scripts/build-migration-image.sh \
  -t v1.2.3 \
  -r myregistry.azurecr.io \
  -p

# 建置並推送到 GitHub Container Registry
./scripts/build-migration-image.sh \
  -t v1.2.3 \
  -r ghcr.io/myorg \
  -p

# 使用特定的遷移目錄
./scripts/build-migration-image.sh \
  -t v1.2.3 \
  -m ./test-fixtures/mongodb/production/migrations \
  -r myregistry.azurecr.io \
  -p
```

---

## CI/CD 自動化

### Azure DevOps Pipeline

使用 `azure-pipelines-migrations.yml`：

```yaml
# 關鍵配置
variables:
  containerRegistry: 'YourAzureContainerRegistry'  # Service Connection
  imageRepository: 'db-migrate'

stages:
  - CI      # 測試 & 驗證
  - Build   # 建置 Image
  - DeployStaging    # 自動部署到 Staging
  - DeployProduction # 手動審批後部署 Production
```

#### 設定步驟

1. **建立 Azure Container Registry Service Connection**
   - Azure DevOps > Project Settings > Service Connections
   - New > Docker Registry > Azure Container Registry

2. **建立 Kubernetes Service Connection**
   - New > Kubernetes
   - 設定 staging 和 production 連線

3. **設定 Environment Approval**
   - Pipelines > Environments > production
   - Approvals and checks > Add approval

4. **設定 Variable Group (機密)**
   - Library > Variable Groups
   - 新增 `STAGING_DB_PASSWORD`, `PRODUCTION_DB_PASSWORD`

### GitHub Actions

使用 `.github/workflows/migrations.yml`：

```yaml
# 關鍵配置
env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}/db-migrate

jobs:
  test:           # 測試
  build:          # 建置 & 推送
  deploy-staging: # 部署 Staging
  deploy-production:  # 需要手動審批
```

#### 設定步驟

1. **設定 Repository Secrets**
   ```
   STAGING_KUBECONFIG     # Staging K8s kubeconfig (base64)
   PRODUCTION_KUBECONFIG  # Production K8s kubeconfig (base64)
   ```

2. **設定 Environments**
   - Settings > Environments
   - 建立 `staging` 和 `production`
   - production 環境設定 Required reviewers

---

## Kubernetes 部署

> ⚠️ **2026-09-11 更新**：這個章節原本教用 `helm upgrade ./charts/db-migrate` 部署，但那個 Helm chart 從來沒有被建立過，實際照做會直接失敗——`.github/workflows/migrations.yml` 的 deploy job 也曾經犯一樣的錯，已經一起修掉了。目前實際可用、有經過設計討論的部署方式是 **kubectl + ConfigMap/Secret/Job**（不用 Helm），完整範例在 [`k8s/`](../k8s/README.md)，這裡不重複貼——內容包含：
> - Job（含 `backoffLimit: 0` 的理由，見下方提醒）
> - ConfigMap 掛載 migration 檔案（適合檔案小、多專案共用的情況）
> - Secret 範本 + 該用哪個 DB 帳號
> - ServiceAccount/RBAC
>
> 監控遷移執行一樣是標準 `kubectl wait` / `kubectl logs`，範例見 `k8s/README.md` 的「工作流程」章節。

⚠️ **不要把 Job 的 `backoffLimit` 設成大於 0 的值**（本文件先前的範例曾寫 `backoffLimit: 5`，是錯誤示範）。DDL migration 失敗可能留下「SQL 已執行、changelog 未寫入」的半套狀態，自動重試等於讓排程器對著不確定的狀態盲目重跑——細節見 [docs/DDL-PRODUCTION-SAFETY.md](./DDL-PRODUCTION-SAFETY.md) 第 1.8 節。失敗就該停下來讓人看，不是交給 Job controller 自動重來。

---

## 最佳實踐

### ✅ 建議做法

| 實踐 | 說明 |
|------|------|
| **版本化 Image Tag** | 使用語義化版本 (v1.2.3)，不用 `latest` |
| **先 Staging 後 Production** | 所有變更先在 Staging 驗證 |
| **Production 手動審批** | 使用 Environment Approval Gate |
| **驗證開啟** | `migration.validation.enabled=true` |
| **禁止危險操作** | `migration.validation.allowDangerous=false` |
| **保留 Job 日誌** | `ttlSecondsAfterFinished: 86400` |
| **密碼從 Secret** | 永不在 values 中設定密碼 |

### ❌ 避免做法

| 避免 | 原因 |
|------|------|
| 使用 `latest` tag | 無法回滾，難以追蹤 |
| 跳過 Staging | 風險太高 |
| 自動部署 Production | 需要人工確認 |
| 直接修改 Production | 應該走 CI/CD |

### 回滾策略

```bash
# 如果遷移失敗，使用上一個版本重新部署
helm upgrade --install db-migrate-production ./charts/db-migrate \
  --namespace production \
  --set image.tag=v1.2.2 \  # 上一個已知正常的版本
  --set migration.command=status  # 先檢查狀態
  -f values-production.yaml

# 或執行 down 回滾
helm upgrade --install db-migrate-rollback ./charts/db-migrate \
  --namespace production \
  --set image.tag=v1.2.3 \
  --set migration.command=down \
  --set migration.downCount=1 \
  -f values-production.yaml
```

---

## 完整流程範例

### 開發者新增遷移

```bash
# 1. 建立新的遷移檔案
cat > migrations/20250120000001-add-user-status.js << 'EOF'
export const up = async (db) => {
  await db.collection('users').updateMany(
    { status: { $exists: false } },
    { $set: { status: 'active' } }
  );
  await db.collection('users').createIndex({ status: 1 });
};

export const down = async (db) => {
  await db.collection('users').dropIndex('status_1');
  await db.collection('users').updateMany(
    {},
    { $unset: { status: '' } }
  );
};
EOF

# 2. 本地測試
npm run test:migration

# 3. Commit & Push
git add migrations/
git commit -m "feat: add user status field"
git push origin main
```

### CI/CD 自動執行

1. **CI 階段**: 自動執行測試和驗證
2. **Build 階段**: 建立 `db-migrate:v1.2.3` 映像並推送到 Registry
3. **Staging 部署**: 自動部署到 Staging 環境
4. **驗證**: 在 Staging 確認遷移成功
5. **Production 審批**: 審批人確認後觸發 Production 部署
6. **Production 部署**: 部署到 Production 環境

---

## 相關檔案

- [Dockerfile.migrations](../Dockerfile.migrations) - 遷移映像建置檔
- [build-migration-image.sh](../scripts/build-migration-image.sh) - 本地建置腳本
- [azure-pipelines-migrations.yml](../azure-pipelines-migrations.yml) - Azure DevOps Pipeline
- [.github/workflows/migrations.yml](../.github/workflows/migrations.yml) - GitHub Actions
- [charts/db-migrate/values.yaml](../charts/db-migrate/values.yaml) - Helm Chart Values
