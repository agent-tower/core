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

镜像默认构建时安装可 pin 的 Agent CLI：

- `@openai/codex@0.142.4`
- `@anthropic-ai/claude-code@2.1.196`
- `@google/gemini-cli@0.23.0`

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
docker compose exec agent-tower which agent-tower codex claude git rg
docker compose exec agent-tower agent-tower --version
```

更完整的 Docker 部署说明维护在仓库根目录的 `docs/DOCKER.md`。
