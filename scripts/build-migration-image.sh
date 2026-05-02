#!/bin/bash
# ============================================================
# Build Migration Image Script
# 用於建置包含遷移檔案的 Docker Image
# ============================================================
#
# 使用方式:
#   ./scripts/build-migration-image.sh [options]
#
# Options:
#   -t, --tag          Image tag (default: latest)
#   -r, --registry     Registry URL (default: none)
#   -m, --migrations   Migrations directory (default: ./migrations)
#   -p, --push         Push to registry after build
#   -h, --help         Show help
#
# Examples:
#   # 本地建置
#   ./scripts/build-migration-image.sh -t v1.0.0
#
#   # 建置並推送到 registry
#   ./scripts/build-migration-image.sh -t v1.0.0 -r myregistry.azurecr.io -p
#
#   # 指定遷移目錄
#   ./scripts/build-migration-image.sh -t v1.0.0 -m ./test-fixtures/mongodb/test-success/migrations
#
# ============================================================

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Default values
IMAGE_NAME="db-migrate"
IMAGE_TAG="latest"
REGISTRY=""
MIGRATIONS_PATH="./migrations"
PUSH_IMAGE=false
BASE_IMAGE="db-migrate:2.0.0"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -r|--registry)
            REGISTRY="$2"
            shift 2
            ;;
        -m|--migrations)
            MIGRATIONS_PATH="$2"
            shift 2
            ;;
        -p|--push)
            PUSH_IMAGE=true
            shift
            ;;
        -b|--base)
            BASE_IMAGE="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  -t, --tag          Image tag (default: latest)"
            echo "  -r, --registry     Registry URL"
            echo "  -m, --migrations   Migrations directory (default: ./migrations)"
            echo "  -b, --base         Base image (default: db-migrate:2.0.0)"
            echo "  -p, --push         Push to registry after build"
            echo "  -h, --help         Show help"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Build full image name
if [ -n "$REGISTRY" ]; then
    FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
else
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
fi

# Get git info
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Building Migration Image                              ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Image:          $FULL_IMAGE"
echo "  Base Image:     $BASE_IMAGE"
echo "  Migrations:     $MIGRATIONS_PATH"
echo "  Git Commit:     $GIT_COMMIT"
echo "  Build Date:     $BUILD_DATE"
echo "  Push:           $PUSH_IMAGE"
echo ""

# Check migrations directory
if [ ! -d "$MIGRATIONS_PATH" ]; then
    echo -e "${RED}[ERROR] Migrations directory not found: $MIGRATIONS_PATH${NC}"
    exit 1
fi

# Count migration files
MIGRATION_COUNT=$(find "$MIGRATIONS_PATH" -type f \( -name "*.js" -o -name "*.sql" \) | wc -l)
echo -e "${GREEN}[INFO] Found $MIGRATION_COUNT migration files${NC}"

if [ "$MIGRATION_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}[WARN] No migration files found!${NC}"
fi

# List migrations
echo ""
echo -e "${YELLOW}Migrations to bundle:${NC}"
find "$MIGRATIONS_PATH" -type f \( -name "*.js" -o -name "*.sql" \) | sort | while read -r file; do
    echo "  - $(basename "$file")"
done
echo ""

# Step 1: Build base image if needed
echo -e "${BLUE}[STEP 1/3] Checking base image...${NC}"
if ! docker image inspect "$BASE_IMAGE" &>/dev/null; then
    echo -e "${YELLOW}[INFO] Base image not found, building...${NC}"
    docker build -t "$BASE_IMAGE" --target runner -f Dockerfile .
fi

# Step 2: Build migration image
echo -e "${BLUE}[STEP 2/3] Building migration image...${NC}"
docker build \
    -f Dockerfile.migrations \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    --build-arg MIGRATIONS_PATH="$MIGRATIONS_PATH" \
    --build-arg BUILD_DATE="$BUILD_DATE" \
    --build-arg BUILD_VERSION="$IMAGE_TAG" \
    --build-arg GIT_COMMIT="$GIT_COMMIT" \
    -t "$FULL_IMAGE" \
    .

echo -e "${GREEN}[OK] Image built: $FULL_IMAGE${NC}"

# Step 3: Push if requested
if [ "$PUSH_IMAGE" = true ]; then
    echo -e "${BLUE}[STEP 3/3] Pushing to registry...${NC}"
    docker push "$FULL_IMAGE"
    echo -e "${GREEN}[OK] Image pushed: $FULL_IMAGE${NC}"
else
    echo -e "${BLUE}[STEP 3/3] Skipping push (use -p to push)${NC}"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!                                       ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "To run locally:"
echo "  docker run --rm $FULL_IMAGE status"
echo ""
echo "To deploy with Helm:"
echo "  helm upgrade --install migration ./charts/db-migrate \\"
echo "    --set image.repository=${REGISTRY:-local}/${IMAGE_NAME} \\"
echo "    --set image.tag=${IMAGE_TAG}"
echo ""
