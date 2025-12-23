# Multi-stage Dockerfile for MongoDB Migration Testing and Execution
# Uses official MongoDB Docker images for testing via Docker-in-Docker

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

# Install mongosh (MongoDB Shell) - works with all MongoDB versions
RUN curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
    gpg --dearmor -o /usr/share/keyrings/mongodb-8.0.gpg && \
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-8.0.gpg ] http://repo.mongodb.org/apt/debian $(lsb_release -cs)/mongodb-org/8.0 main" | \
    tee /etc/apt/sources.list.d/mongodb-org-8.0.list && \
    apt-get update && \
    apt-get install -y mongodb-mongosh && \
    rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /data/db /var/log/mongodb && \
    chmod -R 777 /data/db /var/log/mongodb

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Copy migration runner script
COPY scripts/k8s-migration-runner.sh /usr/local/bin/migration-runner
RUN chmod +x /usr/local/bin/migration-runner

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

# Default command (will be overridden by K8s Job)
CMD ["migration-runner"]
