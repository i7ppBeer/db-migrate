# ============================================================
# Database Migration Runner
# Contents: src/ + node_modules + entrypoint.sh
# ============================================================

FROM node:20-alpine

RUN apk add --no-cache bash curl mysql-client mongodb-tools

WORKDIR /app

# --- Dependencies ---
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Application ---
COPY src/ ./src/
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh

# --- Security ---
ENV NODE_ENV=production
RUN mkdir -p /app/config /app/migrations /tmp \
    && chown -R 1000:1000 /app/config /app/migrations /tmp
USER 1000

# --- Runtime ---
ENV DB_TYPE=mongodb \
    DB_HOST=localhost \
    DB_PORT=27017 \
    DB_NAME=migrations \
    CONFIG_PATH=/app/config/config.js \
    MIGRATIONS_DIR=/app/migrations

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["up"]
