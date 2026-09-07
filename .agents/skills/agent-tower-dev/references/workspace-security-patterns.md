# Workspace、后台服务与安全边界

修改 Git 操作、持久后台资源、认证、preview 或文件交付时读取本页。路径相对仓库根目录，以下 server 路径省略 `packages/server/src/`。Agent turn / 进程清理见 [pipeline-patterns.md](pipeline-patterns.md)，TeamRun 审查合并规则见 [teamrun-patterns.md](teamrun-patterns.md)。

## Workspace 与 Git

- `services/workspace.service.ts` 组合 workspace 业务，`git/worktree.manager.ts` / `git/git-cli.ts` 封装 Git，`services/workspace-kind.ts` 统一目录语义。复用这些入口，不在 Route 或前端拼接 branch/worktree 路径。
- `WORKTREE` 使用独立分支和目录；`MAIN_DIRECTORY` 直接使用项目目录并支持非 Git Solo。Agent、文件、终端和 preview 使用 DTO 的 `workingDir`，操作前判断 Git capability 与 workspace kind。不能把回收 worktree 的删除逻辑套到项目主目录。
- 一个 Task 可有主 workspace、成员 workspace 和目标提交执行 workspace；hibernate/reactivate 与 merge/archive/delete 是不同操作。修改路径、清理或主 workspace 选择时检查子 workspace、watcher、session 和后台服务，沿既有生命周期入口处理。
- `services/workspace-lifecycle-barrier.ts` 的 app 级 barrier 协调同一 workspace 的 start/restart、merge、hibernate、archive/delete 和 task/project cleanup。停止资源、文件系统操作和终态写入需在相同 barrier 内；多 workspace 通过 `withWorkspaces()` 排序获取，避免锁顺序不一致。

## Workspace 后台服务

入口为 `services/workspace-background-service.service.ts`、`workspace-background-process-manager.ts`、`routes/workspace-services.ts` 和 `mcp/tools/workspace-services.ts`。

- 定义属于 workspace，独立 PTY 属于 app-owned process manager，生命周期不随 Agent turn、Session 自然完成或 Socket 断开结束。跨 turn 运行的开发 server/watch/worker 使用 workspace-context service MCP；普通 Agent 子进程仍按 runtime 规则清理。
- 命令以 `command + args[]`、workspace 内相对 cwd 表达，不新增任意 env 或 shell 字符串输入。自然退出记录 EXITED/FAILED，不自动 crash restart。
- 显式 stop、workspace hibernate/archive/delete 和 task/project cleanup 将 desired state 置为 STOPPED 并清理进程树；reactivate 不自动恢复。应用优雅关闭只停止 runtime、保留 desired state，启动 `reconcile()` 重建仍有效的 desired RUNNING 服务。
- 完全停止指 desired/runtime 均为 STOPPED 且无 runtime identity。定义保留供同名同配置重启，但不显示在列表、不占服务配额；新建和重启完全停止的定义都要在 lifecycle barrier 内检查可用槽位。不要只按记录总数计算配额。
- merge 默认阻止源 workspace 的活跃后台服务。已有 `stopActiveServices` 请求语义表示调用方明确选择先停止；完成 merge gate 后清理、重验再合并，不能在检查失败前先杀进程。
- 日志是有界内存数据，实体删除需释放；seq 仅在同一 `runtimeInstanceId` 内有效。增量请求携带上一 generation，响应分别表达 `reset`、`truncated`、`hasMore`；换代替换缓存，正常分页不等于丢日志。
- Unix 的 poll/signal 复用 `utils/unix-process-identity.ts` adapter，发信号前校验 PID/PGID、birth identity 和每次 launch 的 ownership token；不回退到未校验的 kill。Linux `/proc` start ticks 与 macOS 秒级 marker 能力不同，macOS 必须结合 token。Windows 沿 `taskkill /T /F` 树清理实现。

## HTTP、Socket 与 Agent 身份

主要入口为 `middleware/access-auth.ts`、`tunnel-auth.ts`、`agent-cli-local-only.ts`、`services/access-auth.service.ts`、`utils/agent-api-credential.ts`、`internal-api-token.ts` 和 `socket/middleware/`。

- HTTP 有 tunnel session 和可选 access password 两层保护，浏览器使用签名 HttpOnly cookie；沿现有同源写请求/CSRF 与 Socket 认证检查。公共白名单和 Agent CLI 安装的 local-only 边界不可从普通 CRUD 推导放宽。
- 区分 `agentTowerAuthKind` 的 browser、agent、internal、unauthenticated。密码关闭、缺少 Origin/Referer 或客户端自报 Session/Invocation 都不构成 internal/Agent 身份。
- 托管 Agent 取得服务端签发、绑定 Session/Invocation 的 opaque credential；后端由 credential 恢复身份并拒绝冲突 header。应用级内部进程/独立 MCP 使用 internal token，不能将其作为托管 Agent 的默认广域权限。
- Workspace service 允许已通过 AccessAuth 的 browser 读取 list/logs，控制入口只允许合法 Agent/internal；Route 和 Service 都核验 caller。TeamRun 还验证 invocation、active member 和 `runCommands`，不能靠公开 status cookie 或请求 body 绕过。
- Agent credential 跟随 DriverSession/MCP transport，跨自然 turn 完成和 follow-up 有效；DriverSession dispose、显式 Session stop/delete、启动失败和 app destroy 撤销。不要在消息自然完成时提前失效，也不要在 stop 后保留。
- Access Cookie 名称在请求时按规范化绝对 data dir 派生，不按端口或模块加载时的环境缓存。仅兼容当前实例名称和旧 `agent-tower-access`；preview 过滤需识别完整合法名称族。
- 使用 `utils/error-log.ts:writeErrorLog()` 并沿脱敏边界传递上下文；不能将 token、cookie、prompt、Provider secret、Agent credential 或 TeamRun identity 放进诊断日志。

## Preview Gateway

入口为 `services/preview.service.ts`、`preview-runtime-manager.ts`、`routes/previews.ts` 和 `packages/web/src/hooks/use-previews.ts`。新 UI 通过 `/api/previews/:workspaceId/sessions` 获取独立根路径 gateway；`/view/:workspaceId` 是旧客户端兼容路径。

- target 只允许 loopback。本地用 gateway 独立端口，远程按 workspace 复用独立 Quick Tunnel；会话续租与空闲回收交给 manager，target 变更和 server shutdown 立即失效并清理。
- bootstrap 用 workspace preview token 换独立 HttpOnly Cookie；AccessAuth secret 轮换同步使 gateway secret 失效。外层 access/tunnel/gateway Cookie 不传给目标。
- 若目标自身是 Agent Tower，其同名认证 Cookie 按 workspace 改名隔离，转发前恢复目标名。远程 iframe Cookie 使用 `Secure; SameSite=None; Partitioned`；剥离 Cloudflare 客户端标识头，避免目标误判为自身 tunnel 请求。
- 保留目标根路径、HTTP/WebSocket 与流式响应；仅做 frame header、同 target 绝对 redirect、Cookie domain/basePath 和可选 bridge 注入。不恢复通用 HTML/CSS/JS 路径重写。
- 修改 proxy header、redirect、Cookie、WebSocket、鉴权或租约清理时，运行 preview integration tests，不能只验证普通 GET。

## 文件、附件与 Agent 交付

- `routes/files.ts` / `filesystem.ts` 有路径、realpath、symlink 和内部 data dir 保护。文件编辑器允许用户浏览指定目录，与受 Session 绑定的交付文件不同；新增文件端点应复用适用的根目录约束，不把任意路径交给读写 API。
- `routes/attachments.ts` 管理上传、hash 去重、元数据和历史文件，`services/attachment-context.ts` 生成 Agent 附件上下文。附件 ID、浏览器 URL、磁盘 storagePath 是不同用途；沿客户端 URL 解析入口，不把本机绝对路径作为远程浏览器图片 URL。
- Codex visualization 由 `services/agent-visualization.service.ts` 从有效 `CODEX_HOME/visualizations/YYYY/MM/DD/<threadId>` 读取，仅允许当前 Session snapshot 绑定的 thread。文件名、realpath containment、大小及 `routes/sessions.ts` 的 iframe CSP/sandbox 都需要服务端约束。
- `::agent-download{file="relative/path"}` 是 provider-neutral 的交付声明。`services/agent-artifact.service.ts` 从 CHAT turn 的 assistant/来源 invocation 消息提取声明，用 Session 的 workspace/conversation 解析真实目录，校验路径/大小后复制到 data/artifacts 并记录 hash。下载读取持久化副本，不重新读取客户端传入的 workingDir 或 Agent 原始文件路径。

## 按改动验证

从根目录用 `pnpm exec vitest run <路径>` 选取相关测试；同一单元格中省略目录的文件沿用前一个目录：

| 领域 | 测试入口 |
| --- | --- |
| Workspace / Git | `packages/server/src/services/__tests__/workspace.service.test.ts`、`packages/server/src/git/worktree.manager.test.ts`、`packages/server/src/routes/__tests__/workspaces.test.ts` / `git.test.ts` |
| 后台服务 / 身份 | `packages/server/src/services/__tests__/workspace-background-service.service.test.ts`、`workspace-background-process-manager.test.ts`，以及 routes / mcp 的 `__tests__/workspace-services.test.ts` |
| 认证 / Cookie | `packages/server/src/middleware/__tests__/access-auth.test.ts`、`tunnel-auth.test.ts`、`agent-cli-local-only.test.ts`、`packages/server/src/services/__tests__/access-auth.service.test.ts` |
| Preview | `packages/server/src/routes/__tests__/previews.integration.test.ts`、`packages/server/src/services/__tests__/preview-runtime-manager.test.ts` / `preview.service.test.ts` |
| 文件 / 交付 | `packages/server/src/routes/__tests__/files.test.ts`、`filesystem.test.ts`、`attachments.test.ts`、`sessions-visualizations.test.ts`，以及 `packages/server/src/services/__tests__/agent-artifact.service.test.ts` |

真实 Git、DB、listener 和 process 测试使用隔离目录、可用临时端口及显式 teardown，不连接用户正在使用的 app data dir。
