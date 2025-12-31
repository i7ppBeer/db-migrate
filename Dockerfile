# Multi-stage Dockerfile for MongoDB Migration
# Build targets: 
#   - migration (default): Production migration runner
#   - console: Web console for development

FROM node:20-slim AS base

# Install Docker CLI and basic utilities
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    gnupg \
    lsb-release \
    ca-certificates \
    procps \
    apt-transport-https \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

#############################################
# Migration Stage (Production)
#############################################
FROM base AS migration

# Install production dependencies only
RUN npm ci --only=production

# Copy application code
COPY . .

# Make scripts executable
RUN chmod +x scripts/*.sh

# Create directories
RUN mkdir -p /data/db /var/log/mongodb && \
    chmod -R 777 /data/db /var/log/mongodb

# Create non-root user
RUN useradd -m mongodb-migrate || echo "User exists" && \
    chown -R mongodb-migrate:mongodb-migrate /app /data/db /var/log/mongodb 2>/dev/null || \
    chown -R 1001:1001 /app /data/db /var/log/mongodb

USER mongodb-migrate

# Set environment variables
ENV NODE_ENV=production
ENV MONGODB_TEST_MODE=enabled

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('OK')" || exit 1

# Default command (will be overridden by K8s)
CMD ["/bin/bash", "-c", "/app/scripts/k8s-runner.sh"]

#############################################
# Console Stage (Development)
#############################################
FROM base AS console

# Install git for version control features
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install all dependencies (including dev dependencies)
RUN npm install

# Copy application code
COPY src ./src
COPY web-console ./web-console
COPY scripts ./scripts
COPY *.js *.cjs *.json ./
RUN mkdir -p databases

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start Web Console
CMD ["npm", "run", "console"]
