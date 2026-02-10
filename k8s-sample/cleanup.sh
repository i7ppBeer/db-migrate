#!/bin/bash
# ============================================================
# K8s Sample — 清理所有資源
# ============================================================
set -e

NAMESPACE="db-migrate"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Cleaning up K8s sample resources...${NC}"

# Uninstall Helm releases
for release in mariadb-ddl mongodb-ddl mongodb mariadb; do
  if helm status "$release" -n "$NAMESPACE" &>/dev/null; then
    echo "  Uninstalling $release..."
    helm uninstall "$release" -n "$NAMESPACE"
  fi
done

# Clean up leftover hook resources
kubectl -n "$NAMESPACE" delete jobs --all 2>/dev/null || true
kubectl -n "$NAMESPACE" delete configmaps -l app.kubernetes.io/managed-by=Helm 2>/dev/null || true
kubectl -n "$NAMESPACE" delete sa -l app.kubernetes.io/managed-by=Helm 2>/dev/null || true

# Delete namespace
echo "  Deleting namespace $NAMESPACE..."
kubectl delete namespace "$NAMESPACE" 2>/dev/null || true

echo -e "${GREEN}✓ Cleanup complete${NC}"
echo ""
echo "To also stop minikube:"
echo "  minikube stop"
echo "  minikube delete   # (optional, removes cluster entirely)"
