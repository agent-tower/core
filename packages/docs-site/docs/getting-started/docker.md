---
title: Docker 部署
description: 使用 Docker Compose 启动 Agent Tower。
---

# Docker 部署

仓库提供了 `Dockerfile` 和 `docker-compose.yml`。当前 Docker 形态是单容器部署：容器内运行 `agent-tower` 单服务，同时托管 Web、REST API、Socket.IO 和 SQLite。

## 快速启动

```bash
docker compose up -d --build
```

默认访问地址：

```text
http://localhost:12580
```

Docker 默认通过按需 Cloudflare Quick Tunnel 打开 workspace Preview，因为动态预览网关端口位于容器内部。使用 Preview 时需要容器能够访问 Cloudflare；不使用 Preview 时不会创建额外隧道。

停止服务：

```bash
docker compose down
```

## 数据和项目目录

容器内数据目录固定为 `/data`，compose 使用命名 volume `agent-tower-data` 持久化 SQLite、附件、Provider/Profile 配置、独立对话目录、日志和缓存。

项目目录默认把当前目录映射到容器内 `/workspace`。如果要管理其他宿主机目录：

```bash
AGENT_TOWER_WORKSPACE_DIR=/path/to/projects docker compose up -d --build
```

在 UI 里选择项目时应使用容器内路径，例如：

```text
/workspace/my-repo
```

## 内置 Agent CLI

镜像默认在构建时安装 npm `latest` 标签对应的 Agent CLI：

- `@openai/codex@latest`
- `@anthropic-ai/claude-code@latest`
- `@google/gemini-cli@latest`

`CODEX_CLI_VERSION`、`CLAUDE_CODE_VERSION`、`GEMINI_CLI_VERSION` 默认均为 `latest`，也可以通过 shell 环境变量、本地 `.env` 或 Docker build args 固定版本以便复现或回退。例如：

```bash
CODEX_CLI_VERSION=0.149.1 docker compose build agent-tower
```

CLI 版本在构建镜像时确定，容器启动时不会自动升级。Docker 可能复用已有安装层；要重新获取 `latest`，需要绕过构建缓存：

```bash
docker compose build --no-cache agent-tower
docker compose up -d
```

Gemini CLI runtime 优先使用已安装的 `gemini`，因此会使用镜像内的版本；未安装时才回退到 `npx -y @google/gemini-cli@latest`。

如果只想构建基础服务镜像：

```bash
INSTALL_AGENT_CLIS=false docker compose up -d --build
```

Cursor CLI 默认不内置。`Dockerfile` 提供 `INSTALL_CURSOR_CLI=true` 实验开关，但它依赖官方在线安装脚本，不适合作为可复现默认构建。

## 认证和凭证

镜像不包含任何真实账号、token、cookie 或私钥。Agent CLI 认证需要通过环境变量或目录挂载提供。

常见挂载包括：

```yaml
- ${HOME}/.codex:/home/node/.codex
- ${HOME}/.claude:/home/node/.claude
- ${HOME}/.claude.json:/home/node/.claude.json
- ${HOME}/.gemini:/home/node/.gemini
- ${HOME}/.cursor:/home/node/.cursor
```

如果 agent 需要访问私有仓库，也可以挂载 SSH 和 Git 配置：

```yaml
- ${HOME}/.ssh:/home/node/.ssh:ro
- ${HOME}/.gitconfig:/home/node/.gitconfig:ro
```

不要把真实凭证写进 Dockerfile 或提交到仓库。

## 验证

```bash
docker compose config
docker compose exec agent-tower which agent-tower codex claude gemini git rg
docker compose exec agent-tower agent-tower --version
```

更完整的 Docker 部署说明维护在仓库根目录的 `docs/DOCKER.md`。
