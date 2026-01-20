# ============================================================
# Multi-Database Migration Runner Dockerfile
# Supports: MongoDB, MariaDB/MySQL
# ============================================================

FROM node:20-alpine AS base

# Install common dependencies
RUN apk add --no-cache \
    bash \
    curl \
    mysql-client \
    mongodb-tools

WORKDIR /app

# Copy package files
COPY package*.json ./

# ============================================================
# Development stage
# ============================================================
FROM base AS development

RUN npm install

COPY . .

ENV NODE_ENV=development

CMD ["npm", "run", "dev"]

# ============================================================
# Production stage
# ============================================================
FROM base AS production

RUN npm ci --only=production

COPY src/ ./src/

# ⚠️ 遷移檔案會在建置時由 CI/CD 複製進來
# COPY migrations/ ./migrations/

ENV NODE_ENV=production

# Default command
CMD ["node", "src/cli.js", "--help"]

# ============================================================
# Migration Runner stage
# For running migrations in CI/CD
# ============================================================
FROM production AS runner

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables
ENV DB_TYPE=mongodb
ENV DB_HOST=localhost
ENV DB_PORT=27017
ENV DB_NAME=migrations
ENV CONFIG_PATH=/app/config/config.js
ENV MIGRATIONS_DIR=/app/migrations

# Mount points
VOLUME ["/app/config", "/app/migrations"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["up"]
