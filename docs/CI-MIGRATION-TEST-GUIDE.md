# CI Migration Test 使用指南

本文檔說明 `ci-migration-test.sh` 腳本的使用方式、流程圖及 CI 整合方式。

---

## 目錄

1. [流程圖](#1-流程圖)
2. [快速開始](#2-快速開始)
3. [詳細說明](#3-詳細說明)
4. [CI 整合](#4-ci-整合)
5. [故障排除](#5-故障排除)

---

## 1. 流程圖

### 1.1 完整執行流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CI Migration Test Pipeline                          │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │    Start     │
                              └──────┬───────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 1: 啟動資料庫服務       │
                    │  (MariaDB / MongoDB / Both)     │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 2: 等待資料庫就緒       │
                    │    (Health Check, max 30s)      │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                     Step 3: Migration Test Cycle                            │
│                                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│   │   Phase 1   │    │   Phase 2   │    │   Phase 3   │    │   Phase 4   │ │
│   │   DDL       │───▶│   DCL       │───▶│  Migration  │───▶│  Migration  │ │
│   │  Validate   │    │  Validate   │    │   UP (1st)  │    │    DOWN     │ │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │ ✅/❌            │ ✅/⚠️            │ ✅/❌            │ ✅/❌   │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 5   │ │
│          │                  │                  │           │  Migration  │ │
│          │                  │                  │           │  UP (2nd)   │ │
│          │                  │                  │           └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 6   │ │
│          │                  │                  │           │  DCL Apply  │ │
│          │                  │                  │           └──────┬──────┘ │
│          │                  │                  │                  │        │
│          │                  │                  │                  ▼        │
│          │                  │                  │           ┌─────────────┐ │
│          │                  │                  │           │   Phase 7   │ │
│          │                  │                  │           │   Status    │ │
│          │                  │                  │           │   Check     │ │
│          │                  │                  │           └─────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     Step 4: 測試結果報告         │
                    │  ┌─────────────────────────┐    │
                    │  │ Total:  X tests         │    │
                    │  │ Passed: Y               │    │
                    │  │ Failed: Z               │    │
                    │  │ Time:   Ns              │    │
                    │  └─────────────────────────┘    │
                    └────────────────┬────────────────┘
                                     │
                         ┌───────────┴───────────┐
                         │                       │
                         ▼                       ▼
                   ┌───────────┐          ┌───────────┐
                   │ Failed>0  │          │ Failed=0  │
                   │ exit 1    │          │ exit 0    │
                   │ CI FAILED │          │ CI PASSED │
                   └───────────┘          └───────────┘
```

### 1.2 Phase 詳細說明

```
═══════════════════════════════════════════════════════════════════════════════
                            Validate → Up → Down → Up
═══════════════════════════════════════════════════════════════════════════════

Phase 1: DDL Validate          Phase 2: DCL Validate
┌─────────────────────┐        ┌─────────────────────┐
│ • 檢查 SQL/JS 語法   │        │ • 驗證冪等性         │
│ • 驗證檔名格式       │        │ • 檢查 Annotation    │
│ • 檢查 checksum     │        │ • 確認可重複執行     │
│ • 驗證無孤兒 DROP    │        └─────────────────────┘
└─────────────────────┘                   │
         │                                │ (可選)
         │ 必須成功                        ▼
         ▼
Phase 3: Migration UP (1st)    Phase 4: Migration DOWN
┌─────────────────────┐        ┌─────────────────────┐
│ • 依序執行所有 DDL   │        │ • 反向執行 down()   │
│ • 建立 Tables       │───────▶│ • 刪除所有變更       │
│ • 記錄到 changelog  │        │ • 清除 changelog    │
└─────────────────────┘        └─────────────────────┘
                                          │
                                          ▼
Phase 5: Migration UP (2nd)    Phase 6: DCL Apply
┌─────────────────────┐        ┌─────────────────────┐
│ • 重新執行所有 DDL   │        │ • 執行使用者/權限管理│
│ • 確認可重複部署     │───────▶│ • 啟用 --validate   │
│ • 驗證 idempotent   │        │ • 確認帳號建立成功   │
└─────────────────────┘        └─────────────────────┘
                                          │
                                          ▼
                               Phase 7: Status Check
                               ┌─────────────────────┐
                               │ • 顯示最終狀態       │
                               │ • 確認所有 migration │
                               │   都已成功執行      │
                               └─────────────────────┘
```

### 1.3 測試決策樹

```
                                    開始測試
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
              [MariaDB]                              [MongoDB]
                    │                                      │
           ┌───────┴───────┐                      ┌───────┴───────┐
           │               │                      │               │
           ▼               ▼                      ▼               ▼
     DDL Validate    DCL Validate           DDL Validate    DCL Validate
           │               │                      │               │
           │   ┌───────────┘                      │   ┌───────────┘
           ▼   ▼                                  ▼   ▼
      UP (1st)                                UP (1st)
           │                                      │
           ▼                                      ▼
        DOWN                                    DOWN
           │                                      │
           ▼                                      ▼
      UP (2nd)                                UP (2nd)
           │                                      │
           ▼                                      ▼
      DCL Apply                               DCL Apply
           │                                      │
           ▼                                      ▼
     Status Check                            Status Check
           │                                      │
           └──────────────┬───────────────────────┘
                          ▼
                    產生報告
                          │
                          ▼
              ┌───────────────────────┐
              │  Failed > 0 → exit 1  │
              │  Failed = 0 → exit 0  │
              └───────────────────────┘
```

---

## 2. 快速開始

### 2.1 基本用法

```bash
# 賦予執行權限
chmod +x scripts/ci-migration-test.sh

# 測試全部資料庫 (嚴格模式)
./scripts/ci-migration-test.sh

# 只測試 MariaDB
./scripts/ci-migration-test.sh mariadb

# 只測試 MongoDB
./scripts/ci-migration-test.sh mongodb

# 測試指定專案
./scripts/ci-migration-test.sh mariadb my-project
./scripts/ci-migration-test.sh mongodb my-project

# 允許危險操作 (ALTER TABLE, DROP 等)
./scripts/ci-migration-test.sh all test-success --allow-dangerous
./scripts/ci-migration-test.sh mariadb test-success --allow-dangerous
```

### 2.2 使用 Docker Compose 執行

```bash
# 進入專案目錄
cd /path/to/ddl-migrate

# 執行完整測試
docker compose run --rm migrate sh -c "cd /app && ./scripts/ci-migration-test.sh"
```

---

## 3. 詳細說明

### 3.1 腳本參數

| 參數 | 位置 | 預設值 | 說明 |
|------|------|--------|------|
| `db-type` | $1 | `all` | 資料庫類型：`mariadb`、`mongodb`、`all` |
| `project-name` | $2 | `test-success` | 測試專案名稱 |
| `--allow-dangerous` | flag | `false` | 允許危險操作通過驗證 |

### 3.2 Exit Code

| Exit Code | 意義 | CI 狀態 |
|-----------|------|---------|
| `0` | 所有測試通過 | ✅ PASSED |
| `1` | 有測試失敗 | ❌ FAILED |

### 3.3 測試階段說明

| Phase | 名稱 | 描述 | 失敗處理 |
|-------|------|------|----------|
| 1 | DDL Validate | 驗證 DDL 腳本語法與格式 | 停止測試 |
| 2 | DCL Validate | 驗證 DCL 腳本冪等性 | 警告並繼續 |
| 3 | UP (1st) | 首次執行遷移 | 停止測試 |
| 4 | DOWN | 回滾所有遷移 | 停止測試 |
| 5 | UP (2nd) | 再次執行遷移 | 記錄失敗 |
| 6 | DCL Apply | 執行 DCL 建立帳號 | 警告並繼續 |
| 7 | Status | 檢查最終狀態 | 記錄結果 |

### 3.4 輸出範例

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     CI Migration Test                                         ║
║     Validate → Up → Down → Up                                 ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

配置資訊:
  • 資料庫類型: all
  • 測試專案:   test-success
  • 執行時間:   2025-01-26 14:30:00

┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 啟動資料庫服務
└─────────────────────────────────────────────────────────────────┘
   ▸ 啟動 MariaDB...
   ▸ 啟動 MongoDB...

┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 等待資料庫就緒
└─────────────────────────────────────────────────────────────────┘
   ✅ MariaDB 已就緒 (3s)
   ✅ MongoDB 已就緒 (2s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Testing: mariadb / test-success
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ▸ [Phase 1] DDL Validate...
   ✅ [mariadb] DDL Validate
   ▸ [Phase 2] DCL Validate...
   ✅ [mariadb] DCL Validate
   ▸ [Phase 3] Migration UP (1st)...
   ✅ [mariadb] Migration UP (1st)
   ▸ [Phase 4] Migration DOWN...
   ✅ [mariadb] Migration DOWN
   ▸ [Phase 5] Migration UP (2nd)...
   ✅ [mariadb] Migration UP (2nd)
   ▸ [Phase 6] DCL Apply...
   ✅ [mariadb] DCL Apply
   ▸ [Phase 7] Final Status Check...
   ✅ [mariadb] Final Status

╔═══════════════════════════════════════════════════════════════╗
║                      Test Results                             ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   Total:   14 tests                                           ║
║   Passed:  14                                                 ║
║   Failed:  0                                                  ║
║   Time:    25s                                                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

CI PASSED
```

---

## 4. CI 整合

### 4.1 Azure DevOps Pipeline

```yaml
# azure-pipelines.yml
trigger:
  - main
  - develop

pool:
  vmImage: 'ubuntu-latest'

stages:
  - stage: Test
    displayName: 'Database Migration Test'
    jobs:
      - job: MigrationTest
        displayName: 'Run Migration Tests'
        steps:
          - task: DockerCompose@0
            displayName: 'Start Databases'
            inputs:
              containerregistrytype: 'Container Registry'
              dockerComposeFile: 'docker-compose.yml'
              action: 'Run services'
              detached: true
              buildImages: true

          - script: |
              chmod +x scripts/ci-migration-test.sh
              ./scripts/ci-migration-test.sh all test-success
            displayName: 'Run CI Migration Test'

          - task: PublishTestResults@2
            condition: always()
            inputs:
              testResultsFormat: 'JUnit'
              testResultsFiles: '**/reports/*.xml'
```

### 4.2 GitHub Actions

```yaml
# .github/workflows/migration-test.yml
name: Migration Test

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Start databases
        run: docker compose up -d mariadb mongodb

      - name: Wait for databases
        run: |
          docker compose exec -T mariadb mariadb-admin ping -h localhost -u root -prootpass --wait=30
          docker compose exec -T mongodb mongosh --eval "db.adminCommand('ping')"

      - name: Run Migration Test
        run: |
          chmod +x scripts/ci-migration-test.sh
          ./scripts/ci-migration-test.sh all test-success

      - name: Upload test report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: reports/
```

### 4.3 GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - test

migration-test:
  stage: test
  image: docker:24.0.7
  services:
    - docker:24.0.7-dind
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: "/certs"
  before_script:
    - apk add --no-cache docker-compose
  script:
    - docker compose up -d mariadb mongodb
    - sleep 10
    - chmod +x scripts/ci-migration-test.sh
    - ./scripts/ci-migration-test.sh all test-success
  artifacts:
    when: always
    paths:
      - reports/
```

### 4.4 Jenkins Pipeline

```groovy
// Jenkinsfile
pipeline {
    agent any
    
    stages {
        stage('Start Databases') {
            steps {
                sh 'docker compose up -d mariadb mongodb'
                sh 'sleep 10'
            }
        }
        
        stage('Migration Test') {
            steps {
                sh 'chmod +x scripts/ci-migration-test.sh'
                sh './scripts/ci-migration-test.sh all test-success'
            }
        }
    }
    
    post {
        always {
            sh 'docker compose down -v'
            archiveArtifacts artifacts: 'reports/**', allowEmptyArchive: true
        }
    }
}
```

---

## 5. 故障排除

### 5.1 常見問題

#### 資料庫啟動逾時

```
❌ MariaDB 啟動逾時
```

**解決方案：**
```bash
# 手動檢查容器狀態
docker compose ps
docker compose logs mariadb

# 清除舊資料重新啟動
docker compose down -v
docker compose up -d mariadb
```

#### Validate 失敗

```
❌ [mariadb] DDL Validate
```

**解決方案：**
```bash
# 單獨執行 validate 查看詳細錯誤
docker compose run --rm migrate validate -c /app/databases/mariadb/test-success/ddl/config.js

# 常見原因：
# 1. 檔名格式錯誤 (應為 YYYYMMDDHHMMSS-xxx.sql)
# 2. SQL 語法錯誤
# 3. 存在孤兒 DROP 語句
```

#### DOWN 失敗

```
❌ [mariadb] Migration DOWN
```

**解決方案：**
```bash
# 檢查 down() 函數是否正確
docker compose run --rm migrate status -c /app/databases/mariadb/test-success/ddl/config.js

# 可能原因：
# 1. down() 函數缺失或不完整
# 2. 外鍵約束導致無法刪除
# 3. 資料依賴導致回滾失敗
```

### 5.2 除錯技巧

```bash
# 查看詳細日誌
docker compose run --rm migrate up -c /app/databases/mariadb/test-success/ddl/config.js 2>&1 | tee migration.log

# 進入容器除錯
docker compose run --rm --entrypoint sh migrate

# 連接資料庫檢查
docker compose exec mariadb mariadb -u root -prootpass -e "SHOW TABLES;"
docker compose exec mongodb mongosh --eval "db.getCollectionNames()"

# 清除所有狀態重新測試
docker compose down -v
./scripts/ci-migration-test.sh
```

### 5.3 效能優化

```bash
# 平行測試（如果 MariaDB 和 MongoDB 獨立）
./scripts/ci-migration-test.sh mariadb test-success &
./scripts/ci-migration-test.sh mongodb test-success &
wait

# 使用本地快取
docker compose build --build-arg BUILDKIT_INLINE_CACHE=1 migrate
```

---

## 附錄：完整參數列表

```bash
./scripts/ci-migration-test.sh [db-type] [project-name] [--allow-dangerous]

# db-type 選項:
#   all      - 測試 MariaDB 和 MongoDB (預設)
#   mariadb  - 只測試 MariaDB
#   mongodb  - 只測試 MongoDB

# project-name 選項:
#   test-success  - 預設測試專案
#   test-failure  - 預期失敗的測試專案
#   my-project    - 自訂專案名稱

# --allow-dangerous:
#   允許 ALTER TABLE, DROP, TRUNCATE 等危險操作通過驗證

# 環境變數:
#   無額外環境變數需要設定，使用 docker-compose.yml 中的預設值
```
