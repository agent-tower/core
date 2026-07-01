# Docker Compose 部署

第一版 Docker 部署使用单个增强镜像：镜像内运行 `agent-tower` 单服务，同时托管 Web、API、Socket.IO 和 SQLite。默认监听 `12580`，数据目录固定为 `/data`，项目目录建议映射到 `/workspace`。

## 镜像内容

- Agent Tower 生产发布产物，构建时复用 `pnpm build:publish`。
- Node.js 22、git、openssh-client、bash、curl、ripgrep、ca-certificates、tini。
- 默认内置可 pin 的 Agent CLI：
  - `@openai/codex@0.142.4`，提供 `codex`
  - `@anthropic-ai/claude-code@2.1.196`，提供 `claude`
  - `@google/gemini-cli@0.23.0`，提供 `gemini`
- 如果外部 CLI 包或网络临时不可用，可用 `INSTALL_AGENT_CLIS=false` 构建只含 Agent Tower 和基础开发工具的镜像。
- Cursor CLI 不默认安装。官方安装脚本不适合稳定 pin，Dockerfile 提供 `INSTALL_CURSOR_CLI=true` 实验开关。

## 快速启动

```bash
docker compose up -d --build
```

如果只想先启动基础服务，不安装内置 Agent CLI：

```bash
INSTALL_AGENT_CLIS=false docker compose up -d --build
```

访问：

```text
http://localhost:12580
```

查看日志：

```bash
docker compose logs -f agent-tower
```

停止：

```bash
docker compose down
```

## 项目目录映射

compose 默认把当前目录映射到容器内 `/workspace`。如果要管理其他项目目录：

```bash
AGENT_TOWER_WORKSPACE_DIR=/path/to/projects docker compose up -d --build
```

在 Agent Tower UI 中选择项目路径时，应选择容器内路径，例如：

```text
/workspace/my-repo
```

注意：项目路径会按容器内绝对路径保存。切回非 Docker 方式运行时，可能需要重新选择宿主机路径。

## 持久化数据

`/data` 使用命名 volume `agent-tower-data`。其中包括：

- `data.db`：SQLite 数据库
- `attachments/`：上传附件
- `providers.json`、`profiles.json`：Provider/Profile 自定义配置
- `conversations/`：独立对话工作目录
- `logs/`：运行错误日志
- `cache/`：Prisma 等运行期缓存

## Agent CLI 认证

镜像只内置 CLI 命令，不内置任何账号、token、cookie 或私钥。认证建议通过环境变量或目录挂载提供。

常见挂载示例已经写在 `docker-compose.yml` 注释中，按需取消注释：

```yaml
- ${HOME}/.codex:/home/node/.codex
- ${HOME}/.claude:/home/node/.claude
- ${HOME}/.claude.json:/home/node/.claude.json
- ${HOME}/.gemini:/home/node/.gemini
- ${HOME}/.cursor:/home/node/.cursor
```

Linux 上还需要检查 owner 和权限。容器默认以 `node` 用户运行，通常是 `1000:1000`；如果宿主机的 `~/.codex`、`~/.claude`、`~/.gemini`、`~/.cursor` 是其他 owner 且权限较严，例如 `700`，CLI 可能读不到登录态。可选做法是使用同 UID 的宿主账号运行、调整目录 ACL/权限，或派生镜像改运行用户。

也可以通过 compose 环境变量传入 API key：

```yaml
ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
OPENAI_API_KEY: ${OPENAI_API_KEY}
GEMINI_API_KEY: ${GEMINI_API_KEY}
CURSOR_API_KEY: ${CURSOR_API_KEY}
```

不要把真实凭证写死进 Dockerfile 或提交到仓库。

### Codex

当前 executor 调用 `codex`，并检测 `/home/node/.codex/auth.json`；如果 Provider 使用 profile，还需要 `/home/node/.codex/config.toml`。通常挂载宿主机 `~/.codex` 即可。

### Claude Code

当前 executor 调用 `claude`，并检测 `/home/node/.claude.json`。如使用 Claude Code settings 或 MCP 配置，也建议挂载 `~/.claude`。

### Gemini CLI

当前 executor 固定调用：

```bash
npx -y @google/gemini-cli@0.23.0
```

镜像内已全局安装并预热该版本 npm cache，但 `npx` 在某些网络或 cache 状态下仍可能访问 npm registry。UI 可用性检测主要看 `/home/node/.gemini/oauth_creds.json`、`settings.json` 或 `installation_id`，因此建议挂载 `~/.gemini`。

### Cursor CLI

默认镜像不安装 `cursor-agent`。如需实验性内置：

```bash
INSTALL_CURSOR_CLI=true docker compose build --no-cache
docker compose up -d
```

更稳妥的方式是基于本 Dockerfile 派生自己的镜像，按团队认可的 Cursor CLI 安装方式固定版本，并挂载 `/home/node/.cursor` 或传入 `CURSOR_API_KEY`。

## Git 和 SSH

如果 Agent 需要访问私有仓库或 push 代码，挂载 SSH 和 git 配置：

```yaml
- ${HOME}/.ssh:/home/node/.ssh:ro
- ${HOME}/.gitconfig:/home/node/.gitconfig:ro
```

建议先在宿主机完成 known_hosts 初始化。若容器内需要写入 `known_hosts`，把 `.ssh` 改为可写挂载或单独挂载 known_hosts 文件。

容器默认使用 Node 镜像内的 `node` 用户，UID/GID 通常是 `1000:1000`。Linux bind mount 如果遇到文件权限问题，可以调整宿主目录权限，或派生镜像改运行用户。

## 备份和升级

备份数据 volume：

```bash
docker run --rm \
  -v agent-tower-data:/data:ro \
  -v "$PWD:/backup" \
  busybox tar czf /backup/agent-tower-data.tgz -C /data .
```

恢复到空 volume：

```bash
docker run --rm \
  -v agent-tower-data:/data \
  -v "$PWD:/backup:ro" \
  busybox sh -c 'cd /data && tar xzf /backup/agent-tower-data.tgz'
```

升级源码后重建并启动：

```bash
docker compose up -d --build
```

Agent Tower CLI 启动时会对 `/data/data.db` 执行 Prisma `db push --skip-generate`。升级前仍建议先备份 `agent-tower-data`。

## 验证命令

```bash
docker compose config
docker compose exec agent-tower which agent-tower codex claude git rg
docker compose exec agent-tower agent-tower --version
```

Gemini 当前由 executor 通过 `npx` 启动，可用下面命令检查 cache/网络路径：

```bash
docker compose exec agent-tower npx -y @google/gemini-cli@0.23.0 --version
```

## 当前限制

- 没有内置任何真实认证信息，所有 Provider 仍需要用户挂载配置目录或传 env。
- Cursor CLI 默认不内置，实验开关依赖官方在线安装脚本，不适合作为可复现默认构建。
- `/workspace` 下路径是容器路径，不能与宿主机路径混用。
- Provider 命令 override 本轮未改；第一版通过镜像 PATH 中提供标准命令名来适配现有 executor。
