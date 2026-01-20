# 本地測試 Migration Image 手冊

本手冊說明如何在本地環境測試 Migration Image，包含啟動假 DB 和執行 up/down/up 流程。

## 目錄

1. [快速開始](#快速開始)
2. [手動步驟詳解](#手動步驟詳解)
3. [使用不同資料庫](#使用不同資料庫)
4. [從 Registry 拉取 Image](#從-registry-拉取-image)
5. [常用指令速查](#常用指令速查)

---

## 快速開始

### 方式一：一鍵測試腳本

```bash
# 執行完整測試 (up -> down -> up)
./scripts/local-test.sh

# 指定 image 版本
./scripts/local-test.sh -i db-migrate:v1.2.3

# 測試 MariaDB
./scripts/local-test.sh -d mariadb

# 測試完後清理
./scripts/local-test.sh -c
```

### 方式二：手動執行

```bash
# 1. 啟動假 MongoDB
docker compose -f docker-compose.local-test.yml up -d mongodb

# 2. 等待 DB 啟動 (約 10 秒)
sleep 10

# 3. 執行 up
docker compose -f docker-compose.local-test.yml run --rm migration up

# 4. 執行 down
docker compose -f docker-compose.local-test.yml run --rm migration down

# 5. 再次執行 up
docker compose -f docker-compose.local-test.yml run --rm migration up

# 6. 查看狀態
docker compose -f docker-compose.local-test.yml run --rm migration status

# 7. 清理
docker compose -f docker-compose.local-test.yml down -v
```

---

## 手動步驟詳解

### Step 1: 建置 Migration Image

如果還沒有 image，先建置：

```bash
# 建置本地 image
./scripts/build-migration-image.sh -t v1.0.0

# 或從 registry 拉取
docker pull myregistry.azurecr.io/db-migrate:v1.0.0
docker tag myregistry.azurecr.io/db-migrate:v1.0.0 db-migrate:v1.0.0
```

### Step 2: 啟動測試用資料庫

```bash
# 啟動 MongoDB (無認證)
docker compose -f docker-compose.local-test.yml up -d mongodb

# 或啟動 MongoDB (帶認證)
docker compose -f docker-compose.local-test.yml up -d mongodb-auth

# 或啟動 MariaDB
docker compose -f docker-compose.local-test.yml up -d mariadb

# 等待資料庫就緒
sleep 10

# 確認資料庫狀態
docker compose -f docker-compose.local-test.yml ps
```

### Step 3: 執行 Migration 指令

```bash
# 查看狀態 (有哪些 migration 待執行)
docker compose -f docker-compose.local-test.yml run --rm migration status

# 執行所有待執行的 migrations
docker compose -f docker-compose.local-test.yml run --rm migration up

# 回滾最後一個 migration
docker compose -f docker-compose.local-test.yml run --rm migration down

# 驗證 migration 檔案
docker compose -f docker-compose.local-test.yml run --rm migration validate
```

### Step 4: 清理測試環境

```bash
# 停止容器
docker compose -f docker-compose.local-test.yml down

# 停止並刪除資料 (volumes)
docker compose -f docker-compose.local-test.yml down -v
```

---

## 使用不同資料庫

### MongoDB (無認證)

```bash
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

環境變數:
- `DB_HOST=mongodb`
- `DB_PORT=27017`
- `DB_NAME=test_db`

### MongoDB (帶認證)

```bash
docker compose -f docker-compose.local-test.yml up -d mongodb-auth
docker compose -f docker-compose.local-test.yml run --rm migration-auth up
```

環境變數:
- `DB_HOST=mongodb-auth`
- `DB_USER=admin`
- `DB_PASSWORD=testpassword`

### MariaDB

```bash
docker compose -f docker-compose.local-test.yml up -d mariadb
docker compose -f docker-compose.local-test.yml run --rm migration-mariadb up
```

環境變數:
- `DB_HOST=mariadb`
- `DB_PORT=3306`
- `DB_USER=migrate`
- `DB_PASSWORD=migratepass`

---

## 從 Registry 拉取 Image

### Azure Container Registry

```bash
# 登入 ACR
az acr login --name myregistry

# 拉取 image
docker pull myregistry.azurecr.io/db-migrate:v1.2.3

# 設定環境變數
export MIGRATION_IMAGE=myregistry.azurecr.io/db-migrate:v1.2.3

# 執行測試
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

### GitHub Container Registry

```bash
# 登入 GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# 拉取 image
docker pull ghcr.io/myorg/db-migrate:v1.2.3

# 設定環境變數
export MIGRATION_IMAGE=ghcr.io/myorg/db-migrate:v1.2.3

# 執行測試
docker compose -f docker-compose.local-test.yml up -d mongodb
docker compose -f docker-compose.local-test.yml run --rm migration up
```

### 直接使用 docker run

```bash
# 啟動 MongoDB
docker run -d --name test-mongo -p 27017:27017 mongo:7

# 執行 migration (替換 image 名稱)
docker run --rm \
  --network host \
  -e DB_TYPE=mongodb \
  -e DB_HOST=localhost \
  -e DB_PORT=27017 \
  -e DB_NAME=test_db \
  myregistry.azurecr.io/db-migrate:v1.2.3 \
  up

# 清理
docker stop test-mongo && docker rm test-mongo
```

---

## 常用指令速查

### Migration 指令

| 指令 | 說明 |
|------|------|
| `up` | 執行所有未執行的 migration |
| `down` | 回滾最後一個 migration |
| `status` | 查看 migration 狀態 |
| `validate` | 驗證 migration 檔案 |
| `test` | 測試 migration (up 後立即 down) |

### Docker Compose 指令

```bash
# 啟動服務
docker compose -f docker-compose.local-test.yml up -d mongodb

# 執行 migration
docker compose -f docker-compose.local-test.yml run --rm migration <command>

# 查看日誌
docker compose -f docker-compose.local-test.yml logs -f mongodb

# 停止服務
docker compose -f docker-compose.local-test.yml down

# 停止並清除資料
docker compose -f docker-compose.local-test.yml down -v
```

### 測試腳本參數

```bash
./scripts/local-test.sh [options]

Options:
  -i, --image     Migration image (default: db-migrate:v1.0.0)
  -d, --db        Database: mongodb, mongodb-auth, mariadb
  -c, --clean     測試完後清理
  -h, --help      顯示說明
```

---

## 完整測試流程範例

```bash
# 1. 建置 image
./scripts/build-migration-image.sh -t v1.0.0

# 2. 啟動 MongoDB
docker compose -f docker-compose.local-test.yml up -d mongodb
sleep 10

# 3. 查看初始狀態
docker compose -f docker-compose.local-test.yml run --rm migration status
# 預期: 5 pending migrations

# 4. 執行 UP
docker compose -f docker-compose.local-test.yml run --rm migration up
# 預期: 執行所有 migrations

# 5. 再次查看狀態
docker compose -f docker-compose.local-test.yml run --rm migration status
# 預期: 4-5 applied, 0-1 pending

# 6. 執行 DOWN (回滾 1 個)
docker compose -f docker-compose.local-test.yml run --rm migration down
# 預期: 回滾最後一個 migration

# 7. 再次執行 UP
docker compose -f docker-compose.local-test.yml run --rm migration up
# 預期: 重新執行剛回滾的 migration

# 8. 最終狀態
docker compose -f docker-compose.local-test.yml run --rm migration status
# 預期: 與 step 5 相同

# 9. 清理
docker compose -f docker-compose.local-test.yml down -v
```

---

## 疑難排解

### 連線逾時

如果看到 `Database connection timeout`，確認:

1. 資料庫容器是否已啟動: `docker ps`
2. 網路是否正確: `docker network ls`
3. 等待足夠時間讓 DB 啟動

### Permission Denied

如果腳本無法執行:

```bash
chmod +x scripts/local-test.sh
chmod +x scripts/build-migration-image.sh
```

### Image 找不到

如果 image 不存在:

```bash
# 查看本地 images
docker images | grep db-migrate

# 如果沒有，建置一個
./scripts/build-migration-image.sh -t v1.0.0
```
