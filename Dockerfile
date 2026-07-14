ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=10.24.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION

WORKDIR /app
ENV CI=1
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    openssl \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/server/prisma packages/server/prisma
COPY packages/server/scripts packages/server/scripts
COPY packages/web/package.json packages/web/package.json

RUN pnpm --filter @agent-tower/shared --filter @agent-tower/server --filter web install --frozen-lockfile

COPY . .
RUN pnpm build:publish

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.142.4
ARG CLAUDE_CODE_VERSION=2.1.196
ARG GEMINI_CLI_VERSION=0.23.0
ARG INSTALL_AGENT_CLIS=true
ARG INSTALL_CURSOR_CLI=false

ENV NODE_ENV=production \
  AGENT_TOWER_DATA_DIR=/data \
  AGENT_TOWER_HOST=0.0.0.0 \
  AGENT_TOWER_PORT=12580 \
  HOME=/home/node \
  SHELL=/bin/bash \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  PATH=/home/node/.local/bin:/usr/local/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    openssl \
    procps \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN if [ "${INSTALL_AGENT_CLIS}" = "true" ]; then \
      npm install -g \
        "@openai/codex@${CODEX_CLI_VERSION}" \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@google/gemini-cli@${GEMINI_CLI_VERSION}"; \
    fi \
  && npm cache clean --force

RUN if [ "${INSTALL_CURSOR_CLI}" = "true" ]; then \
      mkdir -p /opt/cursor-agent-home; \
      HOME=/opt/cursor-agent-home bash -lc 'set -euo pipefail; curl -fsSL https://cursor.com/install | bash'; \
      ln -sf /opt/cursor-agent-home/.local/bin/cursor-agent /usr/local/bin/cursor-agent; \
      ln -sf /opt/cursor-agent-home/.local/bin/agent /usr/local/bin/agent; \
      chmod -R a+rX /opt/cursor-agent-home; \
    fi

COPY --from=build /app/packages/server/publish /tmp/agent-tower-publish

RUN cd /tmp/agent-tower-publish \
  && npm pack --pack-destination /tmp \
  && npm install -g /tmp/agent-tower-*.tgz --omit=dev \
  && rm -rf /tmp/agent-tower-publish /tmp/agent-tower-*.tgz /root/.npm

RUN mkdir -p /data /workspace /home/node/.npm /home/node/.local/bin \
  && chown -R node:node /data /workspace /home/node

USER node
WORKDIR /workspace

ENV NPM_CONFIG_CACHE=/home/node/.npm \
  NPM_CONFIG_PREFER_OFFLINE=true

RUN if [ "${INSTALL_AGENT_CLIS}" = "true" ]; then \
      npm cache add "@google/gemini-cli@${GEMINI_CLI_VERSION}"; \
    fi \
  && npm cache verify

EXPOSE 12580
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const port = process.env.AGENT_TOWER_PORT || 12580; fetch('http://127.0.0.1:' + port + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["tini", "--"]
CMD ["agent-tower", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "12580"]
