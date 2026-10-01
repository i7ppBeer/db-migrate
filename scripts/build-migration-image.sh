#!/bin/bash
# ============================================================
# Build Migration Image Script
# Builds a Docker image that has a project's migration files (and,
# optionally, its config.js) baked in, on top of the db-migrate runner image.
#
# This is the alternative to the k8s/ ConfigMap approach (see k8s/README.md):
# one immutable image per migration set. The layout inside the image matches
# what k8s/job.yaml mounts, so the same commands work either way:
#   /app/migrations/          migration files
#   /app/config/config.js     config (with -c)
#   /app/config/migrations -> /app/migrations   (so a config with the default
#                              relative migrationsDir './migrations' works too)
# ============================================================
#
# Usage:
#   ./scripts/build-migration-image.sh [options]
#
# Options:
#   -t, --tag          Image tag (default: latest)
#   -r, --registry     Registry URL (default: none)
#   -m, --migrations   Migrations directory (default: ./migrations)
#   -c, --config       config.js to bake in at /app/config/config.js (optional —
#                      otherwise mount one at run time)
#   -b, --base         Runner base image (default: db-migrate:<package.json version>,
#                      built from ./Dockerfile if it doesn't exist locally)
#   -p, --push         Push to registry after build
#   -h, --help         Show help
#
# Examples:
#   ./scripts/build-migration-image.sh -t v1.0.0 -m ./projects/shop/ddl/migrations -c ./projects/shop/ddl/config.js
#   ./scripts/build-migration-image.sh -t v1.0.0 -m ./projects/shop/ddl/migrations -r myregistry.azurecr.io -p
#
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo latest)"

IMAGE_NAME="db-migrate"
IMAGE_TAG="latest"
REGISTRY=""
MIGRATIONS_PATH="./migrations"
CONFIG_PATH=""
PUSH_IMAGE=false
BASE_IMAGE="db-migrate:${TOOL_VERSION}"

usage() {
    sed -n '/^# Options:/,/^# Examples:/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -t|--tag)        IMAGE_TAG="$2"; shift 2 ;;
        -r|--registry)   REGISTRY="$2"; shift 2 ;;
        -m|--migrations) MIGRATIONS_PATH="$2"; shift 2 ;;
        -c|--config)     CONFIG_PATH="$2"; shift 2 ;;
        -b|--base)       BASE_IMAGE="$2"; shift 2 ;;
        -p|--push)       PUSH_IMAGE=true; shift ;;
        -h|--help)       usage; exit 0 ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            usage
            exit 1
            ;;
    esac
done

if [ -n "$REGISTRY" ]; then
    FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
else
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
fi

GIT_COMMIT=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Building Migration Image                              ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Configuration:${NC}"
echo "  Image:          $FULL_IMAGE"
echo "  Base Image:     $BASE_IMAGE"
echo "  Migrations:     $MIGRATIONS_PATH"
echo "  Config:         ${CONFIG_PATH:-(none — mount one at /app/config/config.js at run time)}"
echo "  Git Commit:     $GIT_COMMIT"
echo "  Build Date:     $BUILD_DATE"
echo "  Push:           $PUSH_IMAGE"
echo ""

if [ ! -d "$MIGRATIONS_PATH" ]; then
    echo -e "${RED}[ERROR] Migrations directory not found: $MIGRATIONS_PATH${NC}"
    exit 1
fi
if [ -n "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
    echo -e "${RED}[ERROR] Config file not found: $CONFIG_PATH${NC}"
    exit 1
fi

# Only top-level migration files are picked up by the tool, so only those are counted/copied
MIGRATION_COUNT=$(find "$MIGRATIONS_PATH" -maxdepth 1 -type f \( -name "*.js" -o -name "*.sql" \) | wc -l)
echo -e "${GREEN}[INFO] Found $MIGRATION_COUNT migration file(s)${NC}"
if [ "$MIGRATION_COUNT" -eq 0 ]; then
    echo -e "${RED}[ERROR] No migration files (*.sql / *.js) in $MIGRATIONS_PATH — refusing to build an empty migration image${NC}"
    exit 1
fi
find "$MIGRATIONS_PATH" -maxdepth 1 -type f \( -name "*.js" -o -name "*.sql" \) | sort | while read -r file; do
    echo "  - $(basename "$file")"
done
echo ""

# Step 1: runner base image
echo -e "${BLUE}[STEP 1/4] Checking base image...${NC}"
if docker image inspect "$BASE_IMAGE" &>/dev/null; then
    echo -e "${GREEN}[OK] Using existing $BASE_IMAGE${NC}"
else
    echo -e "${YELLOW}[INFO] $BASE_IMAGE not found locally, building it from $REPO_ROOT/Dockerfile...${NC}"
    docker build -t "$BASE_IMAGE" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
fi

# Step 2: migration image, from a minimal build context holding only the
# migrations (and config) — nothing else from the working tree leaks in
echo -e "${BLUE}[STEP 2/4] Building migration image...${NC}"
CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
mkdir -p "$CONTEXT/migrations"
find "$MIGRATIONS_PATH" -maxdepth 1 -type f \( -name "*.js" -o -name "*.sql" \) -exec cp {} "$CONTEXT/migrations/" \;
CONFIG_COPY=""
if [ -n "$CONFIG_PATH" ]; then
    cp "$CONFIG_PATH" "$CONTEXT/config.js"
    CONFIG_COPY="COPY config.js /app/config/config.js"
fi

cat > "$CONTEXT/Dockerfile" <<EOF
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
COPY migrations/ /app/migrations/
RUN mkdir -p /app/config && ln -s /app/migrations /app/config/migrations
${CONFIG_COPY}
LABEL org.opencontainers.image.created="${BUILD_DATE}" \\
      org.opencontainers.image.revision="${GIT_COMMIT}" \\
      org.opencontainers.image.version="${IMAGE_TAG}" \\
      db-migrate.base-image="${BASE_IMAGE}" \\
      db-migrate.migration-count="${MIGRATION_COUNT}"
EOF

docker build --build-arg BASE_IMAGE="$BASE_IMAGE" -t "$FULL_IMAGE" "$CONTEXT"

# Step 3: check the image really contains what we meant to bake in
echo -e "${BLUE}[STEP 3/4] Verifying image contents...${NC}"
IN_IMAGE=$(docker run --rm --entrypoint sh "$FULL_IMAGE" -c 'ls /app/migrations | wc -l' | tr -d '[:space:]')
if [ "$IN_IMAGE" != "$MIGRATION_COUNT" ]; then
    echo -e "${RED}[ERROR] Image has $IN_IMAGE migration file(s) in /app/migrations, expected $MIGRATION_COUNT${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] Image built: $FULL_IMAGE ($IN_IMAGE migration file(s))${NC}"

# Step 4: push
if [ "$PUSH_IMAGE" = true ]; then
    echo -e "${BLUE}[STEP 4/4] Pushing to registry...${NC}"
    docker push "$FULL_IMAGE"
    echo -e "${GREEN}[OK] Image pushed: $FULL_IMAGE${NC}"
else
    echo -e "${BLUE}[STEP 4/4] Skipping push (use -p to push)${NC}"
fi

CONFIG_ARG="-c /app/config/config.js"
MOUNT_HINT=""
if [ -z "$CONFIG_PATH" ]; then
    MOUNT_HINT="-v \$(pwd)/config.js:/app/config/config.js:ro "
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Build Complete!                                       ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo "Validate what's in the image (no database needed):"
echo "  docker run --rm ${MOUNT_HINT}$FULL_IMAGE validate $CONFIG_ARG"
echo ""
echo "Run against a database (credentials via env, never baked in):"
echo "  docker run --rm ${MOUNT_HINT}-e MARIADB_HOST=... -e MARIADB_USER=... -e MARIADB_PASSWORD=... \\"
echo "    $FULL_IMAGE sync $CONFIG_ARG"
echo ""
echo "For Kubernetes, use this image in k8s/job.yaml in place of the migrations ConfigMap — see k8s/README.md."
