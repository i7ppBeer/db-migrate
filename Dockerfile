# ============================================================
# Database Migration Runner
# Contents: src/ + node_modules + entrypoint.sh
# ============================================================

FROM node:20-alpine

RUN apk add --no-cache bash curl mysql-client mongodb-tools python3 \
 && KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt) \
 && curl -sLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod +x /usr/local/bin/kubectl

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

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["--helper"]
