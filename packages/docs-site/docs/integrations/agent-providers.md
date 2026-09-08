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

## Runtime

Provider 的 `runtimeType` 有两种选择：

| Runtime | 行为 | 当前 Agent 支持 |
| --- | --- | --- |
| `CLI` | 启动本机 CLI，通过 PTY、Parser 和 MsgStore 处理输出 | Claude Code、Gemini CLI、Cursor Agent、Codex |
| `ACP` | 通过 Agent Client Protocol 双向通信，支持能力协商、session 恢复和权限请求 | Claude Code、Gemini CLI、Cursor Agent、Codex、Qwen Code、Kiro CLI、OpenCode、Pi Coding Agent、Grok Build |

旧 Provider 和旧备份没有 `runtimeType` 时按 `CLI` 读取，因此升级不会改变已有配置。同一 Agent 的 CLI 与 ACP 是两个独立默认项；设置其中一个不会取消另一个的默认状态。

Provider 页面不会使用 CLI/ACP Tab。创建配置时，Agent 下拉会直接显示 `Claude Code`、`Claude Code (ACP)`、`Codex`、`Codex (ACP)` 和 `Qwen Code (ACP)` 等可用组合。系统内部仍分别保存 `AgentType + RuntimeType`，Runtime 不会变成独立的顶层配置视图。

ACP Provider 可以选择权限策略：

- `ASK`：Agent 请求工具权限时，在 Session 面板中等待用户选择 Agent 提供的选项。
- `UNRESTRICTED`：关闭 Agent 的沙盒或受限执行模式，并使用 Agent 原生的 full access、bypass、yolo 或 force 能力；没有原生全权限模式的 Agent 才由 Agent Tower 自动响应剩余的工具权限请求。

旧 Provider 中的 `AUTO_APPROVE` 按 `UNRESTRICTED` 兼容读取，并在下次保存时迁移为新值。无限制只跳过工具执行权限；登录、表单提问和其他需要用户输入的交互仍会正常显示。

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

启动时，通用 ACP Driver 会按 Agent Definition 将 Provider 配置投影为对应 adapter 或原生 ACP CLI 的启动参数、环境变量和 Session 配置。

Codex (ACP) 配置了官方 API Key 或简单 OpenAI-compatible 网关时，会在创建 Session 前显式选择该 Provider 的认证方式，不依赖机器上已有的 Codex 登录缓存。未配置上述认证方式时仍沿用 Codex 自身的 ChatGPT/API Key 登录状态。

### Codex Fast 模式

Codex CLI 和 Codex (ACP) Provider 都可以启用 Fast 模式。它只对 Codex 当前声明支持 Fast tier 的模型生效；支持的模型速度约提升至 1.5 倍，同时增加用量消耗。

- Codex CLI Runtime 会为初始执行和 follow-up 注入 `features.fast_mode = true` 与 `service_tier = "fast"`。
- Codex ACP Runtime 会在 adapter 广告 `fast-mode` session option 后，通过 [ACP session config option](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/session-config-options.mdx) 的 `session/set_config_option` 设置，不会把 `/fast` 当作 prompt 发送。
- 使用 ChatGPT 登录时，Fast 模式按更高倍率消耗额度；使用 API Key 时走 API Priority processing 的独立计费。可用模型和费率以 [Codex Speed 官方文档](https://learn.chatgpt.com/docs/agent-configuration/speed) 为准。

Provider 未配置该字段时沿用 Codex 自身配置；显式关闭时，该 Provider 使用标准速度。

### Codex 推理强度

Codex Provider 的推理强度会根据所选模型和运行时目录动态显示。基础档位为 `minimal`、`low`、`medium`、`high` 和 `xhigh`；支持的新版模型还可能声明 `max` 或 `ultra`。`ultra` 会原样写入 `model_reasoning_effort`，不会自动转换为 `max`。

Agent Tower 会调用 Codex 的模型目录发现能力，并在保存或测试 Provider 时再次校验。旧版 Codex、无法读取模型目录或未识别的自定义模型会回退到基础档位；如果已保存的 Provider 使用当前运行时不支持的档位，保存或测试会返回明确诊断，不会静默降级。

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

创建 Session 后，`agentType` 和 `runtimeType` 会固化到 Session。后续消息只能切换到相同 Agent 和相同 Runtime 的 Provider；CLI 与 ACP 之间切换需要创建新 Session。

## 常见操作

Provider 页面支持：

- 列出所有 provider
- 创建 provider
- 更新 provider
- 删除 provider
- 导出备份
- 从备份导入
- 重新加载配置

Agent 环境页面支持检测和引导安装部分本机 Agent CLI。安装前会展示官方来源、下载摘要、风险提示和校验信息。Claude Code 与 Codex 的安装入口面向本机 CLI；它们的 ACP Runtime 已内置，其中 Codex ACP 会优先使用检测到的系统安装。Qwen Code、Kiro CLI、OpenCode 和 Grok Build 当前不在安装清单中，需要用户自行安装对应 CLI；Pi Coding Agent 已内置，Provider 可用性会直接检测随 Agent Tower 发布的 Runtime。

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
