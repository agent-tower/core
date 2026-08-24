# Agent Tower Agent 浏览器评估

评估日期：2026-08-17

## 结论

对 Agent Tower 当前的本地 E2E、并行 TeamRun、截图留证场景，建议继续使用 `agent-browser`，但立即从本机的 `0.17.0` 升级并固定到 `0.34.0`。这次升级比替换产品更有价值：热命令中位数从 165 ms 降到 25 ms，完整核心表单路径从 1.22 s 降到 0.30 s；使用 `batch` 后，包含刷新、填写、选择、勾选、提交、断言和截图的确定性路径中位数约 0.19 s。

最近几个月确实出现了有价值的新工具，但没有一个全面胜过 `agent-browser 0.34.0`：

- Microsoft `@playwright/cli` 是最可信的同类替代品，功能完整、会话隔离正确，也擅长生成可维护的 Playwright 代码；但在本机逐命令工作流约慢 29 倍，单次 `run-code` 仍约慢 9 倍。
- PinchTab 的热命令很快，安全默认值和不可信页面内容边界也做得好；但本次截图稳定超时 30 秒，错误路径仍返回成功退出码，并且默认多个 agent session 共享 Chrome profile 和 `localStorage`，不适合直接替换 Agent Tower 的隔离 session。
- ego lite、Tencent BrowserSkill 更适合需要复用真人登录态、允许人工接管的任务，不适合作为无人值守、本地隔离 E2E 的统一默认浏览器。
- Chrome DevTools MCP 适合作为性能、网络和控制台诊断工具；Browser Use 适合给一个目标后自主完成复杂网页任务。二者都不是这次低层浏览器控制协议的直接替代品。

## 落地状态

- 已将本机 Node.js `22.19.0`、`22.12.0`、`20.19.6` 环境中的全局 `agent-browser` 统一升级到 `0.34.0`；当前命令解析到 Node.js `22.19.0` 下的版本。
- 已同步安装与 CLI 同版本的 `agent-browser` skill，并备份旧 skill 到 `/Users/shitian/.claude/skill-backups/agent-browser-0.17.0-20260817`。
- 已更新 Agent Tower v1.4 TeamRun E2E 提示词，加入版本自检、唯一 session、共享 Chrome 的 `--pin-tab`、scoped snapshot、`batch --bail` 和截图文件验证要求。
- 已完成隔离 session 的表单路径 smoke test；最终 `agent-browser doctor --offline --quick` 为 6 pass、1 warn、0 fail。warning 来自一个升级前已存在的用户 session，为避免破坏已有状态未关闭。
- npm 包声明 Node.js `>=24`。当前 Node 20/22 环境下原生二进制实测可运行，但属于未满足包引擎声明的组合；本次没有擅自升级 Agent Tower 的 Node 运行时。

## 实测环境

- macOS 15.6.1，Apple Silicon arm64
- Node.js 22.19.0，pnpm 11.18.0
- 本机已安装：`agent-browser 0.17.0`
- 候选版本：`agent-browser 0.34.0`、`@playwright/cli 0.1.18`、PinchTab `0.15.1`
- 页面：仅绑定 `127.0.0.1` 的本地动态页面，包含一个完整表单和 500 条动态记录，共约 1008 个可访问性节点
- 路径：刷新、快照、填写姓名、选择角色、勾选条款、提交、读取结果、截图
- 每组重复 5 次，以下为中位数；冷启动另做 3 个新命名 session
- ego lite 和 BrowserSkill 需要安装专用浏览器或扩展并接入真实浏览器数据，本轮没有导入用户 Chrome 数据，因此只做架构和官方资料审查

## 基准结果

### 逐命令 Agent 工作流

| 工具 | 热命令 | 大页面快照 | 快照输出 | 核心路径，不含截图 | 截图 | 默认 session 状态隔离 |
|---|---:|---:|---:|---:|---|---|
| `agent-browser 0.17.0` | 165 ms | 200 ms | 17,018 B | 1.22 s | 通过 | 通过 |
| `agent-browser 0.34.0` | **25 ms** | **77 ms** | 40,576 B | **0.30 s** | 通过 | 通过 |
| `@playwright/cli 0.1.18` | 1,467 ms | 1,154 ms | 94,295 B | 8.98 s | 通过 | 通过 |
| PinchTab `0.15.1` | 34 ms | 1,011 ms | 26,320 B | 1.42 s | **失败，30 s 超时** | **默认共享 profile** |

PinchTab 的“完整路径 31.47 s”没有直接列入表格，因为其中 30.04 s 来自截图超时。更重要的是，`pinchtab screenshot` 输出 `Error 500: screenshot: context deadline exceeded` 后仍返回成功退出码，截图文件也不存在。这会造成 Agent 假阳性。

### 单次脚本调用

| 工具 | 方式 | 包含截图的完整路径 |
|---|---|---:|
| `agent-browser 0.34.0` | `batch --bail --json` | **0.19 s** |
| `@playwright/cli 0.1.18` | `run-code` | 1.71 s |

这项结果说明确定性路径应优先合并为一次调用。探索性路径仍应遵循 snapshot、act、verify 循环。

### 新 session 启动

在控制进程已经可用时，创建新隔离 session 并打开本地页面的 3 次中位数：

| 工具 | 中位数 |
|---|---:|
| `agent-browser 0.17.0` | 1.74 s |
| `agent-browser 0.34.0` | **1.36 s** |
| `@playwright/cli 0.1.18` | 1.79 s |

PinchTab 是常驻 server-first 架构。首次安全配置完成后，从 server 启动到 instance ready 约 2.61 s，随后第一次导航约 1.59 s，不能与“每个 session 启动独立浏览器”的三项完全等价。

### 缩小快照范围

对同一页面只快照表单区域：

| 工具 | 时间 | 输出 |
|---|---:|---:|
| `agent-browser 0.17.0` | 210 ms | 230 B |
| `agent-browser 0.34.0` | **110 ms** | 454 B |
| `@playwright/cli 0.1.18` | 1,020 ms | 542 B |
| PinchTab `0.15.1` | **110 ms** | 600 B |

`agent-browser 0.34.0` 的全页 `snapshot -i -c` 会保留标题和结构上下文，因此比 `0.17.0` 多约 2.4 倍输出；但用 `-s` 限定目标区域后只剩 454 B。升级提示词时应明确要求优先使用 scoped snapshot，避免把性能提升换成上下文膨胀。

## 隔离与并发

`agent-browser 0.34.0` 的两个命名 session 在同一 origin 分别写入 `localStorage=A` 和 `localStorage=B`，再次读取仍分别得到 A/B，隔离通过。两个 session 并行启动也成功。

Playwright CLI 的两个命名 session 做同样测试，也分别得到 A/B。

PinchTab 的两个 agent session 默认映射到同一个 always-on Chrome profile。session A 写入 A、session B 写入 B 后，两个 tab 都读取到 B。PinchTab 可以通过独立 profile/instance 获得隔离，但这要求 Agent Tower 额外管理 instance 生命周期，不能只把 `--session` 命令机械替换掉。

`agent-browser 0.34.0` 还专门修复了共享 Chrome 场景中并行 session 抢占 tab 的问题，并增加 `--pin-tab`。如果未来连接同一个人工 Chrome，应该从 session 第一条命令开始使用命名 session 和 `--pin-tab`。

## 最近的新候选

| 候选 | 近期状态 | 优势 | 对 Agent Tower 的判断 |
|---|---|---|---|
| `@playwright/cli` | npm 包始于 2026-01，当前 0.1.18 | Microsoft 官方；session、trace、video、network、locator、代码生成；可直接转成正式 Playwright 测试 | 保留为“生成/调试测试代码”的第二工具，不替换默认交互循环 |
| PinchTab | 项目始于 2026-02，当前 0.15.1 | Go 单体、HTTP API、MCP、多实例、强安全默认、页面内容标记为 untrusted | 有潜力，但截图和退出码问题未解决前不进入默认链路；需独立 profile/instance 设计 |
| ego lite | 项目始于 2026-04，当前 1.2.3，暂限 macOS | 专用浏览器、真人与 Agent 分离 Space、继承 Chrome 数据；官方自测宣称复杂任务最高 2.5 倍 | 适合登录态/运营任务的小范围试点；官方速度数据没有独立复现，专用浏览器本体不在同一开源仓库中 |
| Tencent BrowserSkill | 项目始于 2026-06，当前 CLI 0.1.10 | Rust CLI + Chrome 扩展；复用已登录浏览器；Agent Window；内置人工接管 | 适合验证码、登录和人工确认，不适合无人值守 headless E2E 默认值 |
| BrowserAct | 项目始于 2026-02 | stealth、代理、验证码、远程人工接管、多账号 | 适合外部站点反爬任务；对本地 E2E 增加不必要的云服务和身份面 |
| Chrome DevTools MCP | 2025-09 出现，当前 1.7.0 | Google 官方；性能 trace、Core Web Vitals、网络和控制台诊断最强 | 作为专项诊断 MCP，不作为每一步交互的默认浏览器 |
| Browser Use | 2024 年项目，近期仍快速更新 | LLM 自主规划、云浏览器、长任务基准表现强 | 属于上层 browser agent；有额外模型延迟和费用，不应和低层 CLI 延迟直接比较 |

## 为什么最新版 agent-browser 提升明显

本机的 `0.17.0` 发布于 2026-03-08。之后关键变化包括：

- `0.20.0` 移除 Node.js/Playwright daemon，改为全原生 Rust；官方发布说明报告 daemon 内存下降 18 倍、冷启动提升 1.6 倍。
- `0.21.0` 增加 `batch` 和 iframe 支持。
- `0.27.0` 增加 React introspection、Web Vitals 和 SPA `pushstate`。
- `0.27.2` 去除每条热命令固定等待，并增强 click、iframe、wait 可靠性。
- `0.28.0` 增加可裁剪工具集的 MCP server。
- `0.30.0` 增加无需启动 Chrome 的 `read` 命令。
- `0.31.0` 增加 worktree scoped session、restore 和 namespace。
- `0.33.0` 增加内嵌 axe-core 可访问性审计。
- `0.34.0` 修复共享 Chrome 下并行 session 抢 tab，并加入持久 tab 绑定。

这些变化与 Agent Tower 的 TeamRun、worktree、真实 E2E 和并行 session 需求高度重合。

## 建议落地顺序

1. 将执行环境固定为 `agent-browser 0.34.0`，不要直接使用浮动 `latest`。先在一组 E2E 成员上灰度。
2. npm 包声明 Node.js `>=24`，当前环境是 Node 22，安装时会出现 engine warning。支持策略应二选一：升级执行环境 Node，或使用 Homebrew/Cargo 的原生二进制安装方式。不要长期依赖“虽然 warning 但现在还能运行”。
3. 更新 TeamRun E2E 提示词：第一条命令就带唯一 session；已知目标区域优先 `snapshot -s`；确定性多步操作优先 `batch --bail`；截图后验证文件存在；共享 Chrome 时启用 `--pin-tab`。
4. 保留 Playwright CLI/项目 Playwright 测试作为可维护回归测试和复杂 trace 的补充，不要求所有 Agent 都走 MCP。
5. ego lite 或 BrowserSkill 只针对“必须使用真人登录态/验证码/人工接管”的成员做独立试点，不与本地 E2E session 混用。
6. 暂缓 PinchTab 默认接入，至少等待截图超时、错误退出码和 profile 隔离策略得到确认后再复测。

## 官方资料

- [agent-browser README](https://github.com/vercel-labs/agent-browser) 与 [v0.34.0 release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.34.0)
- [agent-browser v0.20.0 全原生 Rust release](https://github.com/vercel-labs/agent-browser/releases/tag/v0.20.0)
- [Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli) 与 [v0.1.18 release](https://github.com/microsoft/playwright-cli/releases/tag/v0.1.18)
- [PinchTab](https://github.com/pinchtab/pinchtab) 与 [v0.15.1 release](https://github.com/pinchtab/pinchtab/releases/tag/v0.15.1)
- [ego lite](https://github.com/citrolabs/ego-lite)
- [Tencent BrowserSkill](https://github.com/Tencent/BrowserSkill)
- [BrowserAct Skills](https://github.com/browser-act/skills)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Browser Use](https://github.com/browser-use/browser-use)

## 结果边界

本次是本地 Agent Tower E2E 控制面的微基准，不代表公网反爬成功率、验证码通过率或长任务自主成功率。ego lite 的“最高 2.5 倍”和 Browser Use 的自主任务榜单来自各自官方资料，本次没有复现。PinchTab 的截图问题只证明在本机、该版本、该大页面 fixture 上稳定复现，不推断所有页面都会失败。
