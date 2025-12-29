#!/bin/bash
set -e

IMAGE_NAME="mongodb-migrate-console"
TAG="latest"

echo "🏗️  Building Web Console Docker Image..."
docker build -f Dockerfile.console -t ${IMAGE_NAME}:${TAG} .

echo "[OK] Build successful: ${IMAGE_NAME}:${TAG}"
echo ""
echo "[DEPLOY] To run the console:"
echo "docker run -d \\"
echo "  -p 3000:3000 \\"
echo "  -v /var/run/docker.sock:/var/run/docker.sock \\"
echo "  -v \$(pwd)/../my-migration-projects/projects:/projects \\"
echo "  ${IMAGE_NAME}:${TAG}"
