---
title: Agent Provider
description: 为不同任务选择不同 agent 配置。
---

# Agent Provider

Provider 是 agent 的具体配置实例。它决定某个任务使用哪种 Agent 身份、哪种 Runtime、哪些环境变量和运行参数。

## 支持的 agent

当前支持：

- Claude Code（CLI、ACP）
- Gemini CLI（CLI、ACP）
- Cursor Agent（CLI、ACP）
- Codex（CLI、ACP）
- Qwen Code（ACP）
- Kiro CLI（ACP）
- OpenCode（ACP）
- Pi Coding Agent（ACP）
- Grok Build（ACP）
- DeepSeek Harness（ACP）

## Runtime

Provider 的 `runtimeType` 有两种选择：

| Runtime | 行为 | 当前 Agent 支持 |
| --- | --- | --- |
| `CLI` | 启动本机 CLI，通过受管进程、PTY 或双向管道、Parser 和 MsgStore 处理输出 | Claude Code、Gemini CLI、Cursor Agent、Codex |
| `ACP` | 通过 Agent Client Protocol 双向通信，支持能力协商、session 恢复和权限请求 | Claude Code、Gemini CLI、Cursor Agent、Codex、Qwen Code、Kiro CLI、OpenCode、Pi Coding Agent、Grok Build、DeepSeek Harness |

旧 Provider 和旧备份没有 `runtimeType` 时按 `CLI` 读取，因此升级不会改变已有配置。同一 Agent 的 CLI 与 ACP 是两个独立默认项；设置其中一个不会取消另一个的默认状态。

Provider 页面不会使用 CLI/ACP Tab。创建配置时，Agent 下拉会直接显示 `Claude Code`、`Claude Code (ACP)`、`Codex`、`Codex (ACP)` 和 `Qwen Code (ACP)` 等可用组合。系统内部仍分别保存 `AgentType + RuntimeType`，Runtime 不会变成独立的顶层配置视图。

## 三档执行权限

CLI 与 ACP 使用同一组选择，保存到 Provider 顶层 `executionPermission`：

| 值 | 名称 | 行为 |
| --- | --- | --- |
| `ASK` | 请求批准 | 遵循原生人工审批；原生已允许的操作可以直接执行，不保证每次工具调用都询问。 |
| `AUTO_SANDBOX` | 自动同意（沙箱） | 使用已适配的原生沙箱与自动审阅，保留风险判断、升权及剩余人工请求。 |
| `FULL_ACCESS` | 自动同意（完全访问） | 使用原生广泛批准模式，关闭可控制的沙箱；上游强制规则仍有效。 |

三个选项始终可见。不支持或未核实的项置灰并显示理由；保存、测试和实际启动均校验。新建 Provider 默认 ASK，ASK 不可用时必须手动选择。失效历史值保持可见，不会自动变成完全访问。

权限修改在**新进程或 ACP transport 启动**时生效。复用存活的 ACP 连接保留启动权限，Session 面板显示其启动模式。重启或断线后新启动应用当前选择，恢复原生会话也须显式配置。Cursor、Kiro、Grok 当前接入无法可靠重设恢复会话的权限，新 transport 的 resume/load 会报不支持，需要创建新会话。

如果同 ID 导入把 Provider 的 Agent 或 CLI/ACP 接入方式改了，旧 Session 的新启动会明确拒绝。请用更新后的 Provider 创建新 Session；活动 ACP 连接仍使用已经确认的启动快照。

首版矩阵如下。“支持”表示 Tower 已实现相应原生接口；安装版本仍须接受参数并广告所需 ACP 模式，否则启动报错。尚未完成所有 Agent 的真实模型 smoke。

| Agent / Runtime | 请求批准 | 沙箱自动同意 | 完全访问 |
| --- | --- | --- | --- |
| Claude CLI | 条件支持：已验收的原生构建；其余组合置灰 | 置灰：接入链路未核实 | 支持 |
| Codex CLI | 条件支持：已验收的原生 app-server 构建；其余组合置灰 | 条件支持：已验收的原生 app-server 构建；模型可留空使用 Codex 默认值或选择其他模型 | 支持：原有 exec 接入 |
| Gemini / Cursor CLI | 置灰：非交互接入不能转发原生审批 | 置灰：接入链路未核实 | 支持 |
| Codex ACP | 支持 | 支持：原生 `auto_review` | 支持 |
| Claude / Gemini / Qwen / Grok ACP | 支持 | 置灰：原生条件与接入链路未核实 | 支持 |
| OpenCode ACP | 支持：显式 `ask` | 置灰：无原生沙箱档 | 支持：原生 `allow`，保留显式 deny |
| DeepSeek Harness ACP | 支持：工作区内执行，按需升权 | 置灰：独立自动审阅档未核实 | 支持 |
| Kiro ACP | 支持：原生请求 | 置灰：信任规则不等于沙箱 | 置灰：V2/V3 信任配置未核实 |
| Cursor ACP | 置灰：单次 allowlist 配置未核实 | 置灰：沙箱自动审阅未核实 | 支持 |
| Pi ACP | 置灰：普通工具无完整审批门 | 置灰：无原生沙箱档 | 支持：原生默认权限 |
| 历史 Minion ACP | 支持 | 置灰：无原生沙箱档 | 支持；继续隐藏创建入口 |

Codex ACP 历史 ID `read-only` 在当前适配器中实际对应 `workspace-write + on-request + 人工 reviewer`；`agent` 对应 `workspace-write + on-request + auto_review`；`agent-full-access` 对应原生 bypass，不能从 ID 推断沙箱。原生沙箱覆盖范围以 Agent 为准，不承诺隔离全部宿主、MCP 或客户端代理工具。

剩余原生审批始终转发，即使完全访问也不会由通用 Driver 无条件答复允许。计划确认、登录和用户问答继续按原协议处理。

Claude CLI 的「请求批准」会把原生需要审批的动作显示为卡片，提供「本次批准」「本次拒绝」。卡片展示有界、脱敏的命令或路径；批准不会添加永久允许规则。刷新页面可恢复本轮仍有效的请求，停止或原生取消后旧按钮失效。原生已有允许规则的操作仍可直接执行。

当前仅开放已验收的 Darwin arm64 / Claude Code 2.1.293 原生构建，并检查实际可执行文件、构建摘要和版本。未知构建、其他版本/平台、Electron、router 或自定义启动命令/附加参数显示 `CAPABILITY_UNVERIFIED`；缺 CLI 显示 `RUNTIME_MODE_UNSUPPORTED`。保存、测试和实际启动共用检测结果，启动时仍必须完成原生初始化及 `default` 模式确认，失败会结束执行，不会自动更换权限。

这里的支持门槛验证原生审批控制通道，不代表每个模型组合都完成实测。Tower 在发送任务前完成初始化和 `default` 确认，审批消息由本机 CLI 处理，因此当前门槛不按模型名称筛选。真实批准、拒绝和 resume smoke 仅使用兼容 Anthropic 协议的 `deepseek-v4-pro`；官方 Anthropic 模型及其他模型尚未完成该 smoke，不能据此承诺其全部工具行为。编辑运行配置时，选项按当前草稿重新判断；移除不支持的启动覆盖即可修复失效 ASK 配置，无需先改成完全访问。

Claude CLI 每轮使用新进程，续聊通过原生 resume，并在发送任务前重新确认 `default`，包括从历史完全访问会话恢复。收到最终结果后关闭 stdin；根进程退出时开始清理后代，正常收尾另需等待输出 EOF 和服务端消费确认，超时按传输失败处理。该通道不接收任意终端输入；本阶段不开放 AskUserQuestion、计划确认或 Codex app-server 问答。「完全访问」不会替用户回答问题。权限模式仍不等同于主机或多用户资源隔离。

Codex CLI 的「请求批准」通过原生 [app-server](https://learn.chatgpt.com/docs/app-server#approvals) 接入工具执行审批。每轮新建进程，先完成初始化及 `thread/start` 或 `thread/resume`，确认 `on-request + user reviewer + workspace-write` 后才发送任务。续聊再次确认，包括从旧完全访问的 exec 会话恢复。原生请求的命令、终端输入或文件修改可通过现有卡片本次批准/拒绝；批准不保存命令规则或目录授权。页面刷新恢复本轮有效请求，取消、停止和旧轮答复会失效。ASK 是按需人工批准，原生沙箱及已有规则已允许的操作仍可直接执行。

Codex CLI 的「自动同意（沙箱）」复用同一条原生 app-server 通道，每轮新进程及恢复原生 thread 时显式要求并确认 `on-request + auto_review + workspace-write`，确认前不会发送任务。Tower 还固定基础沙箱的额外可写根为空、网络访问关闭，并从原生 thread 响应核对实际值；Provider 高级 TOML 中的 `sandbox_workspace_write` 会被拒绝，继承的原生配置无法绕过启动前的边界校验。若恢复旧 thread 时原生不能确认这两个基础值，本轮会拒绝执行，需要重新建立可确认的会话。它与「请求批准」使用相同的 `workspace-write` 沙箱类型，越界请求交由 Codex 原生自动审阅；原生若仍交给人的命令/文件请求会显示原有审批卡片，并在答复时复核服务端授权。**危险操作没有必定弹出人工审批卡片的保证。**问答、计划、MCP elicitation、独立资源授权及持久目录 grant 仍是独立交互，不能视为执行审批。参见 OpenAI 官方[自动审阅说明](https://learn.chatgpt.com/docs/sandboxing/auto-review)与[权限模式](https://learn.chatgpt.com/docs/permission-modes)。

当前开放 Darwin arm64 / Codex CLI 0.161.0 的已验收构建，服务端检查实际原生文件及摘要，固定到该原生路径启动。未知文件、版本、平台、Electron、自定义启动命令、附加参数或 Provider 的 PATH/PATHEXT 覆盖保持置灰；不自动改为完全访问。实际模型 smoke 使用 `gpt-6-sol` 的 OpenAI-compatible 连接，覆盖命令和越界文件的批准/拒绝、usage、原生会话 ID、exec→ASK 恢复，以及等待审批/执行中取消后立即续聊。构建门槛验证原生协议，不按模型名白名单筛选；其他模型与官方认证路径尚未完成同样的 smoke，模型连接失败也不能算审批验收。

自动审阅档不按 Provider 模型名筛选；模型留空或选择其他模型时，Tower 仍按原生构建、Provider 配置和部署授权检查可用性。每次启动或恢复都会在发送任务前要求 Codex 确认 `auto_review` 及沙箱边界；原生拒绝或不能确认时停止本轮，不切换权限。本机真实验证仅覆盖上述 `gpt-6-sol` 兼容连接，不保证其他账号或模型连接可用。真实 Driver 验证了沙箱内命令无需人工审批、一次临时工作区外写入由原生自动审阅批准、一次临时本机回环网络请求成功、ASK→AUTO_SANDBOX 与 AUTO_SANDBOX→FULL_ACCESS 的原生 thread 恢复、usage，以及 AUTO 执行中取消后旧进程树先清理再启动替换轮次。页面验收另观察到原生自动审阅批准了一次工作区外测试目录的破坏性删除，全程没有人工审批卡片；工作区外写入与本机回环网络请求也没有弹卡。带危险继承配置的 FULL_ACCESS→AUTO_SANDBOX 恢复被启动前校验拒绝。Codex 自动审阅**可能批准含破坏性删除的沙箱外动作**，所以受限部署必须另有可执行的外层资源边界；未明确声明该边界时，即使策略允许此档也返回 `POLICY_ENFORCEMENT_UNAVAILABLE`，不能仅靠禁用完全访问选项限制宿主资源。原生沙箱覆盖范围仍以 Codex 工具为准，不等于整个宿主或 MCP 的隔离。

Codex ASK 原生控制帧不进入终端/日志，普通终端输入不能注入协议。原生 turn 完成后结束 stdin，继续消费尾部输出，再经已有整树清理确认关闭；下一轮等待旧 launch 的真实清理和持久事件确认。本阶段不开放独立问答、计划确认、MCP elicitation、独立资源 grant 或持久目录授权；遇到未支持的请求会明确结束本轮，不自动答复。完全访问仍使用原有 exec 入口，不由通用 Driver 代答问题。

旧 `UNRESTRICTED`、`AUTO_APPROVE`、危险布尔 `true` 读取为 `FULL_ACCESS`。仅有旧权限字段或缺省的 Codex CLI/ACP ASK 必须明确重选（`LEGACY_PERMISSION_REVIEW_REQUIRED`）：旧 CLI 未启用人工审批通道，旧 ACP 未设置 mode、使用 adapter 默认 Agent/自动审阅，无法据旧 ASK 标签确认生效策略。升级保留原选择和诊断，不自动换成沙箱档或完全访问；明确选择新的 `executionPermission=ASK` 才启用人工审阅。其他 Agent 的旧 ACP ASK 保留，Pi 的旧 ASK 不可运行。备份输出版本 2，兼容导入版本 1；首次写旧配置保留 `providers.json.permission-v1.bak`。非法/冲突值返回诊断，规范选择与原生危险覆盖冲突时须移除覆盖。

服务端 `ExecutionPermissionPolicy` 可限制允许档位，默认本地 owner 允许全部支持项；受限策略不能直接启动完全访问 Provider，Pi 禁止完全访问时无可用项。此接口用于后续部署扩展，首版没有用户库、RBAC、跨租户隔离或即时撤权系统。

ACP Provider 沿用对应 Agent 的认证与模型配置，而不是使用一套 ACP 专属密钥：

| Agent | 连接配置 |
| --- | --- |
| Codex (ACP) | 自动优先使用系统 Codex，未检测到时使用内置 Runtime；配置 `OPENAI_API_KEY`、API 地址、模型、推理强度、Fast 模式和 Codex TOML；官方 API Key 会在 ACP 初始化后显式认证，简单的第三方 OpenAI-compatible 地址使用 gateway 认证并投影为独立的 Codex model provider |
| Claude Code (ACP) | 内置 Claude Runtime；配置 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、模型、effort 和 Claude settings JSON |
| Qwen Code (ACP) | `OPENAI_API_KEY`、`OPENAI_BASE_URL`、模型和权限策略 |
| Gemini CLI (ACP) | `GEMINI_API_KEY`、模型和权限策略；根据已安装版本选择 `--acp` 或 `--experimental-acp` |
| Cursor Agent (ACP) | Cursor 登录状态或高级环境变量、模型和权限策略 |
| Kiro CLI (ACP) | Kiro/AWS 登录环境、模型、effort 和权限策略 |
| OpenCode (ACP) | OpenCode 登录状态，或 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和模型 |
| Pi Coding Agent (ACP) | 内置 Pi Runtime；配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、模型和思考强度，或 Pi 支持的环境变量认证 |
| Grok Build (ACP) | `OPENAI_API_KEY` 会映射为 `XAI_API_KEY`，并支持 API 地址、模型和权限策略 |
| DeepSeek Harness (ACP) | 需要本机可执行的 `dsh`；配置 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、模型、思考强度及 ASK/FULL_ACCESS |

启动时，通用 ACP Driver 会按 Agent Definition 将 Provider 配置投影为对应 adapter 或原生 ACP CLI 的启动参数、环境变量和 Session 配置。

Codex (ACP) 配置了官方 API Key 或简单 OpenAI-compatible 网关时，会在创建 Session 前显式选择该 Provider 的认证方式，不依赖机器上已有的 Codex 登录缓存。未配置上述认证方式时仍沿用 Codex 自身的 ChatGPT/API Key 登录状态。

### DeepSeek Harness

DeepSeek Harness（`dsh`）通过官方 automation profile 启动：`dsh --profile acp`。Provider 配置项与其它 ACP Agent 略有不同：

- **凭据**：`DEEPSEEK_API_KEY` 与可选的 `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）。Harness 的凭据解析顺序是「启动环境变量 > 自身凭据文件 > 项目 `.env` > `$DSH_HOME/.env`」，所以 Provider 注入的密钥必定生效；反过来，如果你在 shell 里已经 `export DEEPSEEK_API_KEY`，它会优先于 Provider 配置。
- **模型**：填模型 id，例如 `deepseek-v4-pro`。Harness 的 ACP 模型选项实际是 `[providerRoute, modelId]` 元组，Agent Tower 会按 `deepseek-official` 路由自动编码；如需指向第三方 DeepSeek 兼容网关，可额外设置 `DSH_PROVIDER_ROUTE`。
- **思考强度**：使用 Harness 自己的 `off`、`low`、`high`、`max` 档位，与 Claude/Kiro 的档位不同，不要混用。
- **权限**：Harness 不暴露权限绕过开关，也不提供 ACP mode 选择器，因此权限策略通过启动变量 `DSH_PERMISSION_MODE` 映射到 Harness 自己的权限预设：
  - `ASK` → `workspace-write`：命令被限制在工作区内，工作区外的文件操作会被沙箱直接拒绝；模型可以在同一次失败后用更宽权限重试一次，该重试会以权限请求的形式弹给你确认，同意后才执行。
  - `FULL_ACCESS` → `danger-full-access`：使用原生全访问预设。
  也就是说，「询问」不是对每条命令都提问，而是「默认限制在工作区，越权时按需申请」。
- **数据目录**：Agent Tower 会把 `DSH_HOME` 指向 `~/.agent-tower/deepseek-harness/<providerId>/`（受 `AGENT_TOWER_DATA_DIR` 影响），因此 Harness 的会话、storage 与 profile 按 Provider 隔离并跨启动保留，同时不会改动你自己的 `~/.dsh`。该目录是持久状态，停止 Session 时不会被删除。
- **首次启动**：Agent Tower 会预先写好 `acp` profile 骨架，避免每次启动重新引导；如果 Harness 需要补齐依赖，首次启动会明显变慢，ACP 初始化超时因此放宽到 3 分钟。
- **大图与视觉**：Harness 会把工具结果内联回传，读取图片时是 base64，体积会膨胀约三分之一。该 Agent 因此同时声明**更大的单帧上限**和**工具结果帧归一化**（与 Codex 相同）：`rawInput`、`rawOutput`、`content` 与 metadata 会被限幅，内联的 base64 图片折叠为带体积的文本占位（如 `[image omitted: image/png, 1.9 MiB]`），读取的文件路径仍然保留。二者缺一不可——只提高上限而不归一化，单帧仍会撞上默认 1 MiB 的校验而中断会话。图片在会话日志中本就只显示为不可渲染内容，因此占位不损失可见信息。
- **不支持 Agent 预设（模式）**：DSH Web 界面里的「标准 / PTC / 极简 / 创造」四种模式来自 `dsh-agent-presets` 插件，它只被 Web 组合加载。ACP 接入既没有可选的预设入口，`acp` 组合也不消费预设配置，因此这四种模式在 ACP 下不可用。实测当前 `acp` 组合已包含标准模式的绝大部分工具（仅缺少面向交互界面的提问与呈现工具），所以这不等同于能力缺失。如果将来需要真正的工具集差异，需要先由上游为 ACP 提供预设入口。

### Codex Fast 模式

Codex CLI 和 Codex (ACP) Provider 都可以启用 Fast 模式。它只对 Codex 当前声明支持 Fast tier 的模型生效；支持的模型速度约提升至 1.5 倍，同时增加用量消耗。

- Codex CLI Runtime 会为初始执行和 follow-up 注入 `features.fast_mode = true` 与 `service_tier = "fast"`。
- Codex ACP Runtime 会在 adapter 广告 `fast-mode` session option 后，通过 [ACP session config option](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/session-config-options.mdx) 的 `session/set_config_option` 设置，不会把 `/fast` 当作 prompt 发送。
- 使用 ChatGPT 登录时，Fast 模式按更高倍率消耗额度；使用 API Key 时走 API Priority processing 的独立计费。可用模型和费率以 [Codex Speed 官方文档](https://learn.chatgpt.com/docs/agent-configuration/speed) 为准。

Provider 未配置该字段时沿用 Codex 自身配置；显式关闭时，该 Provider 使用标准速度。

### Codex 推理强度

Codex Provider 的推理强度会根据所选模型和运行时目录动态显示。基础档位为 `minimal`、`low`、`medium`、`high` 和 `xhigh`；`gpt-6-sol` 额外开放 `max` 和 `ultra`，`gpt-6-luna` 额外开放 `max`（[Codex 官方文档](https://learn.chatgpt.com/docs/models)明确不支持 Luna 使用 `ultra`）。CLI 和 ACP Provider 都使用这些模型选项。`ultra` 会原样写入 `model_reasoning_effort`，不会自动转换为 `max`。

Agent Tower 会调用 Codex 的模型目录发现能力，并在保存或测试 Provider 时再次校验。`gpt-6-sol` 即使目录未包含 `ultra` 也允许显式配置，最终是否可执行由 Codex Runtime 决定；`gpt-6-luna` 仅额外允许 `max`。其他模型在旧版 Codex、无法读取模型目录或未识别自定义模型时会回退到基础档位；如果已保存的 Provider 使用当前运行时不支持的档位，保存或测试会返回明确诊断，不会静默降级。

Claude Code 当前文档列出的 effort 档位为 `low`、`medium`、`high`、`xhigh` 和 `max`，具体可用档位仍由模型和 Claude Code 版本决定。`ultracode` 是独立的 Claude Code 设置，不是一个 effort 值；它以 `xhigh` 推理并启用动态工作流编排，不能写成 `effort = "ultracode"`。

Claude Code 与 Codex 的 ACP adapter 及其兼容 Runtime 随 Agent Tower 发布，不要求全局安装 `claude` 或 `codex`。Codex ACP 自动检测 Agent Tower 服务所在环境的系统 `codex`，优先使用检测到的版本；未检测到时才使用内置版本兜底，无需配置路径。检测会排除项目 `node_modules/.bin` 和相对 PATH 目录，避免将项目依赖当作系统安装；检测到的 Codex 启动失败时会报告错误，不会静默切换到内置版本。`CODEX_PATH` 由 Agent Tower 根据检测结果设置，不再作为手动选择运行时的入口。远程或 Docker 部署检测的是服务器或容器内的安装，而非浏览器所在电脑。

Claude Code 仍可以通过 `CLAUDE_PATH`/`CLAUDE_CODE_EXECUTABLE` 显式覆盖内置版本。Pi Coding Agent 的 npm Runtime 同样随 Agent Tower 发布，可以通过 `PI_CODING_AGENT_PATH` 或 `PI_PATH` 覆盖。

每个 Pi 会话使用隔离的 `PI_CODING_AGENT_DIR`；Agent Tower 会在其中生成 `settings.json`、`mcp.json` 和需要时的 `models.json`，通过 Pi settings 加载随 Agent Tower 发布的 `pi-mcp-adapter`。这个方案不会改写用户或项目的 settings/MCP 配置；受管目录权限为 `0700`、文件权限为 `0600`，并在进程结束后清理。`pi-acp` 仍会按上游约定在 `~/.pi/pi-acp` 维护 ACP session 映射，供 session 恢复使用。

## 为什么要按任务选择 Provider

不同任务适合不同成本和能力组合。

例如：

- 简单的文本调整可以用更便宜的配置
- 复杂重构可以用更强的模型
- 需要特定 CLI 行为时可以切到对应 provider

## Provider 包含什么

一个 provider 通常包含：

- 名称
- agentType
- runtimeType
- 环境变量
- Agent 运行配置
- settings
- 是否默认
- 是否启用

创建 Session 后，`agentType` 和 `runtimeType` 会固化到 Session。后续消息只能切换到相同 Agent 和相同 Runtime 的 Provider；CLI 与 ACP 之间切换需要创建新 Session。

## 常见操作

Provider 页面支持：

- 列出所有 provider
- 创建 provider
- 更新 provider
- 启用或禁用 provider
- 删除 provider
- 导出备份
- 从备份导入
- 重新加载配置

在 Provider 配置列表中可以禁用暂时不用的配置。禁用后，配置仍保留在管理列表中，可以继续编辑或重新启用，但不会出现在任务启动、新建对话、渠道切换等 Provider 选择列表中，也不会被自动选为默认配置。已有 Session 的配置名称和运行中的执行不受影响。

启用状态会随配置保存，并在备份、导入和重新加载后保留。旧配置或旧备份没有启用状态时，默认视为启用。

Agent 环境页面支持检测和引导安装部分本机 Agent CLI。安装前会展示官方来源、下载摘要、风险提示和校验信息。Claude Code 与 Codex 的安装入口面向本机 CLI；它们的 ACP Runtime 已内置，其中 Codex ACP 会优先使用检测到的系统安装。Qwen Code、Kiro CLI、OpenCode、Grok Build 和 DeepSeek Harness 当前不在安装清单中，需要用户自行安装对应 CLI；Pi Coding Agent 已内置，Provider 可用性会直接检测随 Agent Tower 发布的 Runtime。

当前环境引导支持：

| CLI | 支持平台 | 安装方式 |
| --- | --- | --- |
| Codex | macOS、Linux | 下载官方安装脚本并执行 |
| Claude Code | macOS、Linux | 下载官方安装脚本并执行 |
| Cursor CLI Agent | macOS、Linux | 下载官方安装脚本并执行 |
| Gemini CLI | macOS、Linux、Windows | 仅检测已安装状态 |

安装相关接口只允许本机访问，避免通过远程 tunnel 触发本机安装操作。

## 备份和导入

备份接口导出的主要是用户层配置，不是仓库代码。

你可以先预览导入结果，再真正导入，避免覆盖不符合预期的配置。

## 使用建议

- 为每类 agent 维护一个稳定默认配置
- 不要把太多临时实验配置直接当主配置
- 当 provider 失效时，先 reload，再检查本机 CLI 是否可用
