# ── Stage 1: install production dependencies only ────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:22-alpine

ARG KUBECTL_VERSION=v1.31.0
ARG HELM_VERSION=v3.16.0

# Install runtime tools
RUN apk add --no-cache curl bash zip ca-certificates

# Install kubectl
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# Install helm
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 linux-amd64/helm \
    && chmod +x /usr/local/bin/helm

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY index.mjs   ./
COPY package.json ./
COPY src/        ./src/

# SKILL.md is copied in by the build script before docker build
COPY SKILL.md /SKILL.md

# Non-root user
RUN addgroup -S mcpuser && adduser -S mcpuser -G mcpuser \
    && mkdir -p /tmp/helm/cache /tmp/helm/config /tmp/helm/data \
    && chown -R mcpuser:mcpuser /tmp/helm /app

ENV HOME=/tmp
ENV HELM_CACHE_HOME=/tmp/helm/cache
ENV HELM_CONFIG_HOME=/tmp/helm/config
ENV HELM_DATA_HOME=/tmp/helm/data
ENV PORT=8403
ENV MCP_TRANSPORT=http
# Production default — override with MCP_AUTH_MODE=oauth-auto for dev environments
ENV MCP_AUTH_MODE=static-bearer

USER mcpuser
EXPOSE 8403
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:8403/health || exit 1

CMD ["node", "index.mjs"]
