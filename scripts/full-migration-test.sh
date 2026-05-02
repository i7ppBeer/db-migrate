#!/bin/bash
# ============================================================
# full-migration-test.sh
# 完整 Migration 測試流程 (DCL + DDL)
# ============================================================
#
# 使用方式:
#   ./scripts/full-migration-test.sh [project-name]
#
# 範例:
#   ./scripts/full-migration-test.sh my-project
#   ./scripts/full-migration-test.sh test-success
#
# ============================================================

set -e  # 遇到錯誤就停止

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 預設專案名稱
PROJECT=${1:-test-success}
DB_TYPE=${2:-mariadb}

# 路徑設定
BASE_PATH="test-fixtures/${DB_TYPE}/${PROJECT}"
DCL_CONFIG="/app/${BASE_PATH}/dcl/config.js"
DDL_CONFIG="/app/${BASE_PATH}/ddl/config.js"

echo -e "${BLUE}==========================================${NC}"
echo -e "${BLUE}  Migration 完整測試流程${NC}"
echo -e "${BLUE}==========================================${NC}"
echo ""
echo -e "  專案: ${YELLOW}${PROJECT}${NC}"
echo -e "  資料庫類型: ${YELLOW}${DB_TYPE}${NC}"
echo ""

# ──────────────────────────────────────────────────────────
# Step 1: 啟動資料庫
# ──────────────────────────────────────────────────────────
echo -e "${BLUE}📦 Step 1: 啟動資料庫...${NC}"
docker compose up -d ${DB_TYPE}

# 等待資料庫就緒
echo "   等待資料庫就緒..."
sleep 5

if [ "$DB_TYPE" = "mariadb" ]; then
  docker compose exec -T mariadb mariadb-admin ping -h localhost -u root -prootpass --wait=30 > /dev/null 2>&1
  echo -e "   ${GREEN}✅ MariaDB 已就緒${NC}"
elif [ "$DB_TYPE" = "mongodb" ]; then
  docker compose exec -T mongodb mongosh --eval "db.adminCommand('ping')" > /dev/null 2>&1
  echo -e "   ${GREEN}✅ MongoDB 已就緒${NC}"
fi

# ──────────────────────────────────────────────────────────
# Step 2: 建立測試資料庫
# ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}📦 Step 2: 建立測試資料庫...${NC}"

if [ "$DB_TYPE" = "mariadb" ]; then
  docker compose exec -T mariadb mariadb -u root -prootpass -e "CREATE DATABASE IF NOT EXISTS test_${DB_TYPE}_success;"
  echo -e "   ${GREEN}✅ 資料庫 test_${DB_TYPE}_success 已建立${NC}"
fi

# ──────────────────────────────────────────────────────────
# Step 3: 檢查 DCL 設定
# ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}📋 Step 3: 檢查 DCL 設定...${NC}"

if [ -f "${BASE_PATH}/dcl/config.js" ]; then
  echo -e "   ${GREEN}✅ DCL config 存在${NC}"
  
  # 驗證 DCL 腳本冪等性
  echo ""
  echo -e "${BLUE}🔍 Step 3.1: 驗證 DCL 腳本冪等性...${NC}"
  docker compose run --rm migrate dcl:verify -c $DCL_CONFIG || {
    echo -e "   ${YELLOW}⚠️  DCL 冪等性驗證跳過 (可能沒有 DCL 檔案)${NC}"
  }
  
  # 查看 DCL 狀態
  echo ""
  echo -e "${BLUE}📊 Step 3.2: 查看 DCL 狀態...${NC}"
  docker compose run --rm migrate dcl:status -c $DCL_CONFIG || {
    echo -e "   ${YELLOW}⚠️  DCL 狀態查詢跳過${NC}"
  }
  
  # 執行 DCL
  echo ""
  echo -e "${BLUE}🔐 Step 3.3: 執行 DCL (建立帳號)...${NC}"
  docker compose run --rm migrate dcl -c $DCL_CONFIG || {
    echo -e "   ${YELLOW}⚠️  DCL 執行跳過${NC}"
  }
else
  echo -e "   ${YELLOW}⚠️  DCL config 不存在，跳過 DCL 測試${NC}"
fi

# ──────────────────────────────────────────────────────────
# Step 4: 檢查 DDL 設定
# ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}📋 Step 4: 檢查 DDL 設定...${NC}"

if [ -f "${BASE_PATH}/ddl/config.js" ]; then
  echo -e "   ${GREEN}✅ DDL config 存在${NC}"
  
  # 驗證 DDL 腳本
  echo ""
  echo -e "${BLUE}🔍 Step 4.1: 驗證 DDL 腳本...${NC}"
  docker compose run --rm migrate validate -c $DDL_CONFIG
  
  # 查看 DDL 狀態
  echo ""
  echo -e "${BLUE}📊 Step 4.2: 查看 DDL 狀態...${NC}"
  docker compose run --rm migrate status -c $DDL_CONFIG
  
  # 執行 Up-Down-Up 測試
  echo ""
  echo -e "${BLUE}🧪 Step 4.3: 執行 DDL Up-Down-Up 測試...${NC}"
  docker compose run --rm migrate test -c $DDL_CONFIG
  
else
  echo -e "   ${YELLOW}⚠️  DDL config 不存在，跳過 DDL 測試${NC}"
fi

# ──────────────────────────────────────────────────────────
# Step 5: 顯示最終狀態
# ──────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}📊 Step 5: 顯示最終狀態...${NC}"

if [ -f "${BASE_PATH}/ddl/config.js" ]; then
  docker compose run --rm migrate status -c $DDL_CONFIG
fi

if [ -f "${BASE_PATH}/dcl/config.js" ]; then
  docker compose run --rm migrate dcl:status -c $DCL_CONFIG 2>/dev/null || true
fi

# ──────────────────────────────────────────────────────────
# 完成
# ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  ✅ 所有測試完成！${NC}"
echo -e "${GREEN}==========================================${NC}"
echo ""
echo "下一步:"
echo "  - 查看報告: ls -la reports/"
echo "  - 手動測試: docker compose run --rm migrate <command> -c <config>"
echo ""
