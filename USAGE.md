# MongoDB Migration 使用流程

## 🔄 工作流程圖

> 如果無法顯示下方的 Mermaid 圖表，請參考底部的文字版流程圖。

```mermaid
flowchart TD
    subgraph Development ["💻 本地開發階段"]
        A["開始"] --> B{"新增 Migration?"}
        B -- Yes --> C["npm run create <br/> -c projects/xxx/config.js"]
        C --> D["編輯 Migration 檔案"]
        D --> E["npm run validate"]
        E --> F["bash scripts/docker-test.sh <br/> (Docker 測試)"]
        F -- 失敗 --> D
        F -- 通過 --> G["Commit & Push"]
        B -- No --> G
    end

    subgraph CI_CD ["⚙️ CI/CD 階段"]
        G --> H["Build Docker Image"]
        H --> I["Push to Registry"]
    end

    subgraph Deployment ["🚀 Kubernetes 部署階段"]
        I --> J["Apply ConfigMap & Secret"]
        J --> K["kubectl apply -f <br/> k8s/migration-job.yaml"]
        
        K --> L["Pod 啟動: <br/> migration-runner"]
        
        L --> M{"SKIP_TESTS?"}
        M -- False --> N["嵌入式 MongoDB 測試 <br/> (6.0, 7.0, 8.0)"]
        N -- 失敗 --> O["Job Failed <br/> (不影響生產環境)"]
        N -- 通過 --> P["連線生產資料庫"]
        M -- True --> P
        
        P --> Q["執行 Migration Up"]
        Q -- 失敗 --> R["自動 Rollback"]
        Q -- 成功 --> S["Job Completed"]
    end

    style Development fill:#e1f5fe,stroke:#01579b
    style CI_CD fill:#fff3e0,stroke:#ff6f00
    style Deployment fill:#e8f5e9,stroke:#2e7d32
```

### 📄 文字版流程圖 (Text Version)

```text
+-----------------------------------------------------------------------+
|                        💻 本地開發階段 (Development)                   |
+-----------------------------------------------------------------------+
|                                                                       |
|  [開始] --> <新增 Migration?> -- Yes --> [npm run create]             |
|                  |                          |                         |
|                  No                         v                         |
|                  |                  [編輯 Migration 檔案]             |
|                  |                          |                         |
|                  |                          v                         |
|                  |                  [npm run validate]                |
|                  |                          |                         |
|                  |                          v                         |
|                  |               [bash scripts/docker-test.sh]        |
|                  |                     (Docker 測試)                  |
|                  |                          |                         |
|                  |        (失敗) <----------+----------> (通過)       |
|                  |          |                               |         |
|                  v          +-------------------------------+         |
|            [Commit & Push] <--------------------------------+         |
|                  |                                                    |
+------------------+----------------------------------------------------+
                   |
                   v
+-----------------------------------------------------------------------+
|                        ⚙️ CI/CD 階段                                  |
+-----------------------------------------------------------------------+
|                  |                                                    |
|                  v                                                    |
|         [Build Docker Image] --> [Push to Registry]                   |
|                                       |                               |
+---------------------------------------+-------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------+
|                        🚀 Kubernetes 部署階段                          |
+-----------------------------------------------------------------------+
|                                       |                               |
|    [Apply ConfigMap & Secret] <-------+                               |
|              |                                                        |
|              v                                                        |
|    [kubectl apply -f k8s/migration-job.yaml]                          |
|              |                                                        |
|              v                                                        |
|    [Pod 啟動: migration-runner]                                       |
|              |                                                        |
|              v                                                        |
|        <SKIP_TESTS?> -- False --> [嵌入式 MongoDB 測試]               |
|              |                        (6.0, 7.0, 8.0)                 |
|              |                               |                        |
|              True                     (失敗) | (通過)                 |
|              |                          |    |                        |
|              |                          v    v                        |
|              +-------------------> [連線生產資料庫]                   |
|                                         |                             |
|                                         v                             |
|                                 [執行 Migration Up]                   |
|                                         |                             |
|                                (失敗) <-+-> (成功)                    |
|                                  |            |                       |
|                                  v            v                       |
|                           [自動 Rollback]   [Job Completed]           |
|                                                                       |
+-----------------------------------------------------------------------+
```

## 📝 常用指令

### 1. 初始化與建立
```bash
# 建立新的 migration 檔案
node src/cli.js create "add-user-fields" -c projects/users/config.js
```

### 2. 驗證與測試
```bash
# 驗證 migration 語法與規則
npm run validate

# 執行完整 Docker 整合測試 (包含 6.0 -> 8.0 升級與 Rollback)
bash scripts/docker-test.sh
```

### 3. 手動執行 (本地開發)
```bash
# 執行特定專案的 migration
node src/cli.js up -c projects/orders/config.js

# 查看狀態
node src/cli.js status -c projects/orders/config.js

# Rollback
node src/cli.js down -c projects/orders/config.js
```

### 4. Kubernetes 部署
```bash
# 部署 Migration Job
kubectl apply -f k8s/migration-job.yaml

# 查看日誌
kubectl logs -f job/mongodb-migration -n mongodb-migrations
```
