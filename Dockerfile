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
RUN mkdir -p /app/reports /tmp && chmod 755 /app/reports /tmp

# --- Runtime ---
ENV DB_TYPE=mongodb \
    DB_HOST=localhost \
    DB_PORT=27017 \
    DB_NAME=migrations

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["up"]
