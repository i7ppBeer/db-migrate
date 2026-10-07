# ============================================================
# Database Migration Runner
# Contents: src/ + node_modules + entrypoint.sh
#
# Two targets from one base, so they can't drift apart:
#   (default)       docker build .                 → db-migrate:<version>
#                   ENTRYPOINT entrypoint.sh, CMD help — docker run / k8s Jobs
#   azure           docker build --target azure .  → db-migrate:<version>-azure
#                   Azure DevOps container jobs: no entrypoint of ours (the
#                   agent runs its own commands in the container), plus the
#                   label that points the agent at this image's node — Alpine
#                   isn't glibc, so the agent's own node can't run here
# ============================================================

FROM node:24-alpine AS base

RUN apk add --no-cache bash curl mongodb-tools python3 py3-yaml \
 && apk upgrade --no-cache curl libssl3 \
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
# /tmp stays world-writable + sticky: the DCL runner (non-root in k8s) writes
# its generated-password hand-off file there (repeatable-runner.js mkdtemp)
RUN mkdir -p /app/reports /tmp && chmod 755 /app/reports && chmod 1777 /tmp

# ------------------------------------------------------------
# Azure DevOps container job image (keeps node:24-alpine's own
# ENTRYPOINT/CMD, as the former Dockerfile.azure did)
# ------------------------------------------------------------
FROM base AS azure
LABEL "com.azure.dev.pipelines.agent.handler.node.path"="/usr/local/bin/node"

# ------------------------------------------------------------
# Default image — last stage, so a plain `docker build .` builds it
# ------------------------------------------------------------
FROM base AS runner

ENTRYPOINT ["/app/docker/entrypoint.sh"]
# No arguments → usage help (a bare `docker run <image>` used to fail with
# "Unknown command: --helper")
CMD ["help"]
