# 进程泄漏审计与修复（2026-09-08）

审计基线：`0705a2c8`。范围包括 Session/CLI/ACP、独立终端、workspace 生命周期、隧道与预览、CLI 安装器、Git 和 Electron 后端。用户要求验证并修复后，以下缺陷已在当前工作区实现修复；未提交或发布。P1 表示优先修复，P2 表示在特定操作或竞态下触发。

已发现并处理 13 处缺陷及相关关闭入口。验证分为真实进程、隔离数据库、模拟依赖与代码调用链分析；Windows/Linux 分支未做实机验证。ACP 为后续对话复用空闲连接本身是设计行为，不能仅凭 Session 已 COMPLETED 就认定进程泄漏；删除、停止后仍有无人负责清理的进程才是以下问题的核心。

## 修复结果

| 原编号 | 修复后的行为 | 主要实现 |
| --- | --- | --- |
| 1–2 | workspace 删除、归档、休眠、周期清理及 conversation 删除停止所有状态的 Session；整树清理未确认时保留目录和进程记录；清理期间阻止创建和续发。Task 删除快照包含全部 Session，旧快照执行时补查当前关联 Session。 | `session-resource-cleanup.ts`、`workspace.service.ts`、`conversation.service.ts`、`task.service.ts`、`task-cleanup.service.ts` |
| 3–4 | Unix 从已验证父子关系/进程组记录不继承环境变量的后代，根退出后继续按 birth identity 清理；Linux 跳过明确属于其他 UID 的环境读取，实际候选探测失败继续保留清理责任。 | `unix-process-identity.ts`、`runtime/acp/process-manager.ts` |
| 5 | 独立终端等待整树退出，必要时升级信号，失败保留 owner；Windows 根退出后按重新核验的后代身份继续清理。 | `terminal-manager.ts` |
| 6 | 并发 tunnel start 共享启动 promise；stop/regenerate 撤销旧启动并等待进程退出，失败可重试。 | `tunnel.service.ts`、`cloudflared-process.ts` |
| 7–8 | 首次并发 preview acquire 共享 gateway；invalidate/stopAll 等待启动交接并取消迟到 tunnel，清理失败保留 owner。 | `preview-runtime-manager.ts`、`routes/previews.ts` |
| 9–10 | CLI 安装取消和自然父退出均等待子树清理；应用退出停止安装及验证进程，并禁止新任务。 | `agent-cli/task-manager.ts`、`agent-cli/environment.service.ts`、`owned-child-process.ts` |
| 11 | Desktop 失败启动保留独立 child，确认其退出后才允许 recovery 重试。 | `desktop/src/main.ts`、`backend-shutdown.ts` |
| 12 | Git 和 CLI 检测/验证命令在超时、取消、输出超限及自然退出后统一清理后代，再返回结果。 | `owned-child-process.ts`、`git/git-cli.ts`、`routes/git.ts`、`agent-cli/command-runner.ts` |
| 13 | Windows CLI wrapper 在根已退出时逐个重新核验并清理已记录后代，不再反复只对消失的根执行 taskkill；忽略 CIM 中无法作为子进程的 PID 0 系统伪行。 | `process-launch.ts`、`runtime/acp/process-manager.ts` |

应用关闭统一覆盖 Session、后台服务、终端、主隧道、预览和通用 child owner；一次失败不会跳过其余 owner，未确认的清理继续重试。关闭入口同步阻止新启动，也覆盖尚未交接的启动操作和延迟 terminal 初始化。

Fastify 关闭前停止调度并关闭升级连接，入口并行执行网络关闭与进程清理，避免 WebSocket、onReady 或请求等待子进程导致死锁。Desktop 和开发 launcher 使用私有 IPC 请求后端清理，后端在初始化早期就保存关闭请求；启动失败确认清理后显式退出，开发模式不再固定 5 秒强杀。已经产生 child 的 started 事件仍必须持久化所有权，不受删除期间的新启动门禁影响。

## 验证与边界

- 删除边界的首轮 7 项回归在修复前失败，修复后通过。新增回归覆盖已完成 ACP、stop 失败、清理未确认、旧任务快照、删除/续发并发，以及清理期间迟到 started 事件仍保存进程证据。
- 真实 macOS 验证覆盖独立 PTY、忽略退出信号的后代、原生 shell/命令、安装器子树、Git hook 超时和真实 HTTP 升级连接；DB 测试使用独立 SQLite 与临时目录。额外启动编译后的真实 CLI 后端，分别在 WebSocket 保持连接和启动早期发送 IPC shutdown，两次均以退出码 0 正常退出。
- Windows 使用进程枚举/信号模拟及真实 Node wrapper 验证控制流，Linux 多 UID 权限场景使用注入文件系统依赖；这些不等价于对应平台实机验收。没有启动真实 Electron 或执行用户环境的真实 CLI 安装。
- 未继承 token 且在任何观测之前就完全脱离父子关系和进程组的后代，不能仅凭旧 PID 安全追认。此修复保留已验证后代并扩大启动时采样，不能提供操作系统容器级的绝对子树隔离。
- 测试只回收自己创建的进程与 listener，未操作用户正在运行的服务。

首轮修复统一验证结果（独立审查补修前）：

| 检查 | 结果 |
| --- | --- |
| Vitest 受影响测试集合（`--maxWorkers=3`） | 35 个文件、396 项全部通过，无跳过或失败 |
| 编译后 CLI 的真实 IPC 退出 | WebSocket 连接中退出、启动早期退出均通过 |
| `pnpm --filter @agent-tower/shared build` | 通过 |
| `pnpm --filter @agent-tower/server build` | 通过，含 Prisma generate 与 TypeScript |
| `pnpm --filter @agent-tower/desktop build` | 通过 |
| `pnpm docs:build` | 通过；构建生成文件已恢复，不混入源码变更 |
| `agent-tower-dev` skill validation / `git diff --check` | 通过 |

统一测试首次执行暴露两处既有测试配置缺失：workspace routes 的临时 SQLite 空文件未建立，ACP lifecycle fixture 未提供当前 MCP 契约要求的地址与凭据。补齐隔离 fixture 后重跑整个集合通过。没有通过跳过测试或放宽生产校验来消除失败。

## 独立审查后的复核与补修

独立审查指出的三项边界均有复现依据。macOS 真实 PTY 与 `runOwnedCommand` 复现了根自然退出后遗留无 token 子进程；Linux 通过注入 `/proc` 复现了同 UID 的无关受保护进程阻断扫描，以及已缓存后代转为 zombie 后仍被判活。

- 独立终端及通用 child owner 增加运行期间的后代采样，合并在途探测；停止后等待采样完成再释放身份缓存。新增真实回归覆盖 `env -i` 后台命令和延迟创建的 `env: {}`、detached 后代，父进程自然退出后确认子进程也已退出。
- Linux 缓存全部已验证身份，并保留本次直接 child 启动时刻。同 UID 的环境权限错误仅在候选明确早于本次启动且没有已验证父子/进程组关联时忽略；无法排除归属的进程仍需保留错误和重试责任，不能用一次 EACCES 把已知 owner 变成空集合。
- Linux 解析 Z/X 状态，僵尸进程不再阻止退出确认；已验证的拓扑仍可用于寻找其他活后代。

本轮没有扩大到 Linux/Windows 实机验收。持续采样可以修复已复现的观测缺口；在两次采样之间产生、清空标记并完全脱离树关系的进程，仍受前述无法安全追认的限制。

补修后重新执行统一测试集合：**35 个文件、403 项全部通过**（`--maxWorkers=2`），无失败或跳过。Server build（含 Prisma generate / TypeScript）、skill validation 和 `git diff --check` 均通过。与首轮相比新增 7 项回归覆盖自然根退出、同 UID 的新旧候选区分、已确认根权限变化，以及已缓存后代变为 Z/X 后仍有活后代。

## 原始复现记录

以下描述、代码行号与“建议”均对应审计基线 `0705a2c8`，保留用于理解修复前的触发条件；不是当前未修复问题列表。

1. **P1：删除 workspace 会跳过已完成但仍持有 ACP 进程的 Session。**

   位置：`packages/server/src/services/workspace.service.ts:1835`、`:1864`；级联关系位于 `packages/server/prisma/schema.prisma:384`、`:460`。

   删除仅对 PENDING/RUNNING Session 调用 stop。ACP 的 COMPLETED/FAILED Session 仍可能持有可复用 adapter，删除直接跳过它们，并级联删除 Session 与 ExecutionProcess。该进程在当前服务内仍可能被 RuntimeCoordinator 持有，但用户停止入口和持久化清理证据已消失，常规恢复扫描也不再能找到它。运行中的 stop 失败同样被吞掉。archive/hibernate 也按业务状态判断，需一并核查空闲 runtime 的处理。

   验证：隔离 SQLite 创建 COMPLETED ACP Session 和 ACTIVE ExecutionProcess，调用真实 WorkspaceService.delete；stop 调用次数为 0，进程记录被级联删除。

   建议：删除前对所有关联 Session 执行 runtime dispose，并通过统一 cleanup gate；未确认清理时保留删除任务和身份记录。

2. **P1：删除独立对话吞掉停止失败，再删除清理证据。**

   位置：`packages/server/src/services/conversation.service.ts:318`。

   `stop(...).catch(() => {})` 后继续删除工作目录和 Conversation，级联删除 Session/ExecutionProcess。若停止超时或身份探测失败，活进程可能继续运行，却失去后续数据库扫描所需的 PID、birth marker 和 ownership token。

   验证：隔离 SQLite 中保留 FAILED 清理记录，注入 stop 拒绝；delete 仍返回 true，目录、Session 和进程记录全部被删。

   建议：将独立对话删除纳入可重试清理流程，未确认进程树退出前不硬删除资源。

3. **P1：ACP 遗漏不继承 ownership token 的后代，错误宣告整树已停止。**

   位置：`packages/server/src/utils/unix-process-identity.ts:105`、`:122`；`packages/server/src/runtime/acp/process-manager.ts:256`、`:265`。

   后代枚举只接受 token 匹配的进程。Agent 使用显式 env 启动工具时，子进程可能不带该变量；当它脱离进程组，或在原组中忽略 SIGTERM 时，根退出后仍然存活，但清理探测忽略它并提前成功，跳过后续 SIGKILL。

   验证：macOS 使用真实 AcpProcessManager 和自建 Node 进程树，结果为 `stopResolved=true`、`descendantAliveAfterStop=true`。

   建议：在根仍存活时结合 PPID/PGID 与 birth identity 跟踪后代，根退出后继续持有清理责任。不能简单删掉身份校验或改成裸 PID 强杀。

4. **P1：Linux 全系统环境扫描被无关用户进程的权限错误阻断。**

   位置：`packages/server/src/utils/unix-process-identity.ts:180`、`:282`；`packages/server/src/runtime/acp/process-manager.ts:256`。

   captureOwnedGroups 对所有 `/proc/<pid>/environ` 执行 Promise.all，任何 EACCES/EPERM 都使全局扫描拒绝。普通用户通常无权读取 root 等其他 UID 进程环境，因此自己创建的 ACP 根可以成功识别、启动，但 stop 在发出任何信号之前失败，重复尝试也无法消除无关权限错误。

   验证：注入 Linux 多 UID 文件系统依赖，本方根身份捕获成功，扫描 `/proc/1/environ` 后全局清理失败。未在 Linux 实机运行。

   建议：先排除能够明确证明不属于本次执行的其他 UID 进程；对实际候选进程的身份探测失败继续保留诊断和重试。

5. **P1：独立终端销毁只发一次 SIGHUP，随后丢弃管理记录。**

   位置：`packages/server/src/services/terminal-manager.ts:215`。

   destroy 释放监听器，调用 `pty.kill()`，立即 removeTerminal。Unix 下底层默认向 shell 发 SIGHUP，没有等待整树退出或升级 SIGKILL。关闭终端、Socket 断开、TTL 回收和应用关闭都经过这里。

   验证：真实 `/bin/sh` PTY 内运行忽略 SIGHUP 的 Node 子进程；destroy 后 manager size 为 0，子进程仍存活。

   建议：采用可等待的进程树清理，整树确认后再删除 owner；失败保持可重试。

6. **P2：主隧道并发启动会覆盖 cloudflared 引用。**

   位置：`packages/server/src/services/tunnel.service.ts:302`、`:318`、`:325`、`:413`。

   仅已取得 URL/token 的隧道能被复用；启动中的状态不阻止另一次 start。两次并发调用分别 Tunnel.quick，覆盖 state.tunnel，stop 只能停止最后一个。等待 binary 安装期间的 stop 也缺少启动取消边界。

   验证：模拟 cloudflared，两个并发 start 创建 2 个实例；stop 只停止 1 个。

   建议：缓存完整启动 promise，并使 stop/regenerate 取消旧 generation；迟到的创建结果必须回收。

7. **P2：首次并发预览创建会遗失 gateway 与 cloudflared。**

   位置：`packages/server/src/services/preview-runtime-manager.ts:585`、`:625`。

   ensureRuntime 先读 map，再 await listen，最后才登记。相同 workspace 的首次并发 acquire 都创建 runtime，后写入者覆盖前者；旧 runtime 不再被 sweep/invalidate/stopAll 遍历。

   验证：真实 HTTP listener 加模拟 cloudflared，首次并发 remote acquire 创建 2 个 gateway 和 2 个 tunnel；stopAll 后剩 1 个 listener、1 个 tunnel。现有并发测试先创建 local runtime，漏掉首次创建窗口。

   建议：按 workspace 缓存整个 runtime 创建 promise，确保创建失败和失效路径也拥有清理责任。

8. **P2：预览已经失效，旧启动仍在 binary 安装结束后创建 cloudflared。**

   位置：`packages/server/src/services/preview-runtime-manager.ts:860`、`:948`、`:954`。

   ensureTunnel 等待 binary 后未复核 stopped/generation。invalidate 或 stopAll 将 runtime 移出 map，stopTunnel 只把 promise 字段清空；旧异步操作并未取消，稍后创建的 tunnel 无人管理。

   验证：挂起 binary setup，invalidate 完成后再放行 setup，仍创建 1 个 tunnel；后续 stopAll 也无法停止它。cloudflared 使用模拟对象。

   建议：让失效操作撤销启动；每个关键 await 后复核 owner，回收所有迟到实例。

9. **P2：取消 CLI 安装时，父进程先退出会跳过子树强杀。**

   位置：`packages/server/src/services/agent-cli/task-manager.ts:179`、`:246`。

   cancel 安排 SIGKILL，但定时器依赖 processes.has(taskId)。父 shell 先退出时 handleInstallerExit 立即删除记录并标记 cancelled，于是忽略 TERM/HUP 的下载器等后代永远等不到强杀。Windows 分支还只调用 child.kill，没有树清理。

   验证：真实隔离进程，测试强杀期限设为 100ms；500ms 后任务已 cancelled、installer 根已退出，后代仍存活。现有测试先触发强杀定时器再模拟父 exit，漏掉此时序。

   建议：将根退出与整树退出分开，保留捕获的进程组/后代身份直到确认清理。

10. **P1：CLI 安装器未纳入应用关闭清理。**

    位置：`packages/server/src/services/agent-cli/task-manager.ts:109`；`packages/server/src/app.ts:145`；`packages/server/src/cli.ts:231`。

    Unix 安装器以 detached 启动，但安装 manager 没有 destroy/stopAll，也未接入关闭协调器。安装过程中关闭应用，安装脚本可继续下载或写入文件；任务和 PID 仅在内存，后端重启没有恢复入口。

    验证：代码调用链分析，未执行真实安装程序。

    建议：提供可等待的 installer manager shutdown，并纳入服务及桌面关闭流程。

11. **P1：Desktop 崩溃恢复重试会覆盖仍存活的 backend。**

    位置：`packages/desktop/src/main.ts:301`、`:397`、`:586`、`:593`。

    限定于崩溃后的 recovery 路径：replacement 已 spawn，但 schema/reconcile 卡住或启动超过 health timeout，startBackend 拒绝；catch 安排再次 recovery，未先停止该 child。下一次 spawn 覆盖全局 backendProcess，旧 backend 不再是 stopBackend 的管理目标，反复超时可持续积累进程。

    验证：完整调用链分析，未启动真实 Electron；不要与初次启动失败后退出应用的路径混为一谈。

    建议：每次启动都有独立 owner；重试前确认失败实例退出，清理失败则继续持有并重试原 owner。

12. **P2：Git 命令超时仅终止 git 根，留下 hook/SSH/helper。**

    位置：`packages/server/src/git/git-cli.ts:147`；同类入口 `packages/server/src/routes/git.ts:37`。

    execFile 的 timeout 没有进程树语义。git 提交 hook、SSH 或其他 helper 若保持存活，git 超时报错后它们不会被回收，用户重试可能叠加。

    验证：临时仓库 pre-commit hook 启动长驻 Node，execGit 超时 300ms 返回 GitError 后，hook 仍存活。

    建议：可启动后代的 Git 操作需要捕获进程组/后代并在超时后清理，不能只依赖 execFile timeout。

13. **P1：Windows CLI 根先退出后，wrapper 反复对已消失的根执行 taskkill。**

    位置：`packages/server/src/utils/process-launch.ts:311`、`:404`。

    Windows 分支始终 taskkill /PID child.pid /T /F；根自然退出后，即使已经记录存活后代 birth identity，也没有逐个终止这些后代。taskkill 缺失根失败，后代与 wrapper 的清理轮询都可能长期存在。

    验证：将实际 wrapperScript 放入 VM 模拟 CIM/taskkill；7 次目标都是已退出 PID 100，后代 PID 101 仍存活、wrapper 未退出。此项没有 Windows 实机验证。

    建议：根退出后继续依据已记录且重新验证的后代身份清理，不能反复依赖已不存在的根 PID。

另外有三处关闭路径会削弱现有清理保障，建议纳入后续修复验收：

- `packages/server/scripts/dev.mjs:193`、`:227` 固定 5 秒后 SIGKILL backend，可能截断仍在执行或重试的清理。热重载能由下一实例恢复部分持久 owner；直接退出没有这一保障。
- `packages/server/src/app.ts:152` 的 workspace background shutdown 只执行一次；`runtime/server-entry-shutdown.ts:21` 吞掉 closeApp 错误后，仅重试 SessionManager。后台清理失败时可能在未确认整树退出前结束服务。PTY wrapper 的 SIGHUP 处理可能兜底，不能据此声称每次退出必然残留。
- `packages/desktop/src/backend-shutdown.ts:43` 用 child.kill(SIGTERM) 做关闭。Windows Node 这里是强制终止，不能假设后端 JS SIGTERM handler 被执行；需考虑 IPC/受认证关闭请求。此项为平台语义分析，未做 Windows 实测。

验证记录：现有 Unix identity/ACP process manager 30 项、安装器/desktop 13 项测试通过。另完成 4 项临时终端/隧道/预览复现与 2 项隔离数据库复现，ACP/Git/安装器有独立真实进程脚本。临时复现断言的是当前错误行为，所以“复现测试通过”表示缺陷成立，并不表示实现正确。首次数据库测试遇到新 SQLite 文件初始化的 schema engine 错误，显式建立临时目录和空库后两项复现均通过。自建进程、listener 和临时测试文件已清理，未操作用户正在运行的服务。

建议修复顺序：先修删除边界和 ACP/终端整树清理，再修并发启动 owner 与 Desktop 重试，最后统一安装器、Git 及各宿主关闭入口。验收应覆盖根先退出、后代不继承环境、权限不相关的系统进程、首次并发创建、启动过程中 stop/delete、清理失败后重试，以及 Windows 实机生命周期。
