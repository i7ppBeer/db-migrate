#!/bin/bash

###############################################
# Build and Push MongoDB Migration Image
###############################################

set -e

# Configuration
IMAGE_NAME="${IMAGE_NAME:-mongodb-migrate}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io/i7ppbeer}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${IMAGE_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Building MongoDB Migration Image${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${BLUE}Image: ${FULL_IMAGE}${NC}\n"

# Build image
echo -e "${BLUE}[BUILD] Building Docker image...${NC}"
docker build \
    --platform linux/amd64 \
    -t "${FULL_IMAGE}" \
    -f Dockerfile \
    .

echo -e "${GREEN}[OK] Image built successfully${NC}\n"

# Tag with version
if [ -n "$VERSION" ]; then
    VERSION_TAG="${IMAGE_REGISTRY}/${IMAGE_NAME}:${VERSION}"
    echo -e "${BLUE}🏷️  Tagging with version: ${VERSION}${NC}"
    docker tag "${FULL_IMAGE}" "${VERSION_TAG}"
fi

# Show image info
echo -e "\n${BLUE}📋 Image information:${NC}"
docker images | grep "${IMAGE_NAME}" | head -5

# Push image
if [ "${PUSH_IMAGE}" = "true" ]; then
    echo -e "\n${BLUE}⬆️  Pushing image to registry...${NC}"
    docker push "${FULL_IMAGE}"
    
    if [ -n "$VERSION" ]; then
        docker push "${VERSION_TAG}"
    fi
    
    echo -e "${GREEN}[OK] Image pushed successfully${NC}"
else
    echo -e "\n${YELLOW}ℹ️  Image not pushed (set PUSH_IMAGE=true to push)${NC}"
fi

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}[OK] Build completed${NC}"
echo -e "${GREEN}========================================${NC}\n"

echo "To push the image, run:"
echo "  PUSH_IMAGE=true $0"
echo ""
echo "To deploy to Kubernetes:"
echo "  kubectl apply -f k8s/"
