#!/bin/bash
# ============================================================
# K8s Sample — 一鍵安裝
# 在 minikube 上部署 MariaDB + MongoDB + 執行 DDL migration
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NAMESPACE="db-migrate"
IMAGE_TAG="3.0.0"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  DB-Migrate K8s Sample — Setup                          ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"

# ── Step 1: Prerequisites ────────────────────────────────────
echo -e "\n${YELLOW}[1/6] Checking prerequisites...${NC}"
for cmd in docker minikube helm kubectl; do
  if ! command -v $cmd &>/dev/null; then
    echo -e "${RED}[ERROR] $cmd not found. Please install it first.${NC}"
    exit 1
  fi
done
echo -e "${GREEN}  ✓ docker, minikube, helm, kubectl${NC}"

# ── Step 2: Start minikube ───────────────────────────────────
echo -e "\n${YELLOW}[2/6] Starting minikube...${NC}"
if minikube status | grep -q "Running" 2>/dev/null; then
  echo -e "${GREEN}  ✓ minikube already running${NC}"
else
  minikube start --driver=docker --memory=4096 --cpus=2
  echo -e "${GREEN}  ✓ minikube started${NC}"
fi

# ── Step 3: Build & load image ───────────────────────────────
echo -e "\n${YELLOW}[3/6] Building db-migrate image...${NC}"
docker build -t "db-migrate:${IMAGE_TAG}" "$PROJECT_DIR" 2>&1 | tail -3
minikube image load "db-migrate:${IMAGE_TAG}"
echo -e "${GREEN}  ✓ db-migrate:${IMAGE_TAG} loaded into minikube${NC}"

# ── Step 4: Deploy databases ────────────────────────────────
echo -e "\n${YELLOW}[4/6] Deploying MariaDB + MongoDB...${NC}"
kubectl create namespace "$NAMESPACE" 2>/dev/null || true

helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
helm repo update >/dev/null 2>&1

if ! helm status mariadb -n "$NAMESPACE" &>/dev/null; then
  helm install mariadb bitnami/mariadb -n "$NAMESPACE" \
    --set auth.rootPassword=rootpass \
    --set auth.database=migrate_test \
    --set auth.username=migrate \
    --set auth.password=migratepass \
    --set primary.persistence.size=1Gi \
    --wait --timeout 3m
  echo -e "${GREEN}  ✓ MariaDB deployed${NC}"
else
  echo -e "${GREEN}  ✓ MariaDB already exists${NC}"
fi

if ! helm status mongodb -n "$NAMESPACE" &>/dev/null; then
  helm install mongodb bitnami/mongodb -n "$NAMESPACE" \
    --set auth.enabled=false \
    --set persistence.size=1Gi \
    --wait --timeout 3m
  echo -e "${GREEN}  ✓ MongoDB deployed${NC}"
else
  echo -e "${GREEN}  ✓ MongoDB already exists${NC}"
fi

# Wait for pods
echo -e "  Waiting for database pods..."
kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/name=mariadb --timeout=120s
kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app.kubernetes.io/name=mongodb --timeout=120s
echo -e "${GREEN}  ✓ All database pods ready${NC}"

# ── Step 5: Run MariaDB migrations ──────────────────────────
echo -e "\n${YELLOW}[5/6] Running MariaDB DDL migrations...${NC}"
helm upgrade --install mariadb-ddl "$PROJECT_DIR/charts/db-migrate" \
  -n "$NAMESPACE" \
  -f "$SCRIPT_DIR/values-mariadb.yaml" \
  --timeout 5m
echo -e "${GREEN}  ✓ MariaDB DDL migration completed${NC}"

# Show logs
MARIA_POD=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/instance=mariadb-ddl,app.kubernetes.io/component=ddl --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null)
if [ -n "$MARIA_POD" ]; then
  echo -e "\n${BLUE}  --- MariaDB Migration Logs ---${NC}"
  kubectl -n "$NAMESPACE" logs "$MARIA_POD" 2>/dev/null | grep -E "✅|Applied|ERROR" || true
fi

# ── Step 6: Run MongoDB migrations ──────────────────────────
echo -e "\n${YELLOW}[6/6] Running MongoDB DDL migrations...${NC}"
helm upgrade --install mongodb-ddl "$PROJECT_DIR/charts/db-migrate" \
  -n "$NAMESPACE" \
  -f "$SCRIPT_DIR/values-mongodb.yaml" \
  --timeout 5m
echo -e "${GREEN}  ✓ MongoDB DDL migration completed${NC}"

# Show logs
MONGO_POD=$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/instance=mongodb-ddl,app.kubernetes.io/component=ddl --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null)
if [ -n "$MONGO_POD" ]; then
  echo -e "\n${BLUE}  --- MongoDB Migration Logs ---${NC}"
  kubectl -n "$NAMESPACE" logs "$MONGO_POD" 2>/dev/null | grep -E "✅|Applied|ERROR" || true
fi

# ── Done ─────────────────────────────────────────────────────
echo -e "\n${BLUE}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All done!${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${YELLOW}Check resources:${NC}"
echo "    kubectl -n $NAMESPACE get pods"
echo "    kubectl -n $NAMESPACE get jobs"
echo ""
echo -e "  ${YELLOW}View migration logs:${NC}"
echo "    kubectl -n $NAMESPACE logs -l app.kubernetes.io/component=ddl"
echo ""
echo -e "  ${YELLOW}Clean up:${NC}"
echo "    bash $SCRIPT_DIR/cleanup.sh"
