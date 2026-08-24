# Lightpanda Browser 项目评估

评估日期：2026-08-18

评估对象：[lightpanda-io/browser](https://github.com/lightpanda-io/browser)，稳定版 `0.3.7`；对照工具为 Agent Tower 当前使用的 `agent-browser 0.34.0 + Chrome`。

## 结论

Lightpanda 值得关注，而且在“抓网页 DOM/文本、批量执行脚本、结构化抽取”这类任务上很有价值；但它目前不是 `agent-browser + Chrome` 的更快替代品，而是一种能力边界不同的专用 Web runtime。

对 Agent Tower 的建议是：

- **不要替换现有 E2E 浏览器。** 保留 `agent-browser 0.34.0 + Chrome` 作为默认浏览器，负责真实截图、布局、响应式、交互兼容性、登录态和最终验收。
- **可以增加 Lightpanda 作为第二后端试点。** 只路由明确不需要像素渲染的研究、抓取、批量 DOM、表单和确定性脚本任务。
- **优先评估原生 MCP/PandaScript 接入，而不是 CDP 套壳。** 本机实测原生 MCP 操作链很快；Lightpanda 的 CDP 虽能运行 Puppeteer/Playwright 的基础路径，但与现有 `agent-browser` 的 target 生命周期不兼容。
- **当前成熟度只适合灰度。** 官方仍标记为 Beta，并明确提示可能出错或崩溃；Web API、CDP 和安全模型都还没有达到 Chrome 等价程度。

一句话判断：它是一个很快的“可执行 DOM/文本浏览器”，不是一个可以验证用户实际所见页面的浏览器。

## 项目概况

| 项目 | 评估结果 |
|---|---|
| 当前稳定版 | `0.3.7`，2026-08-16 发布；GitHub 另有每天更新的 `nightly` |
| 活跃度 | 约 34,047 stars、1,582 forks、88 个 open issues；主分支在评估当天仍有提交 |
| 实现 | Zig + V8 + libcurl + html5ever；不是 Chromium/Blink/WebKit 分支 |
| 平台 | macOS/Linux 的 x64、arm64；Windows 只能通过 WSL，暂无原生二进制 |
| 协议 | `AGPL-3.0-only` |
| 状态 | 官方 Beta，明确提示仍可能出现错误或崩溃 |
| 接口 | CLI fetch、CDP、原生 MCP、内置 Agent、可回放 PandaScript |

0.3.0 到 0.3.7 在约三个月内连续发布，开发速度很快。这是积极信号，但也意味着兼容性和接口仍在快速变化，生产接入应固定版本，不能跟随 `nightly`。

## 它为什么快

Lightpanda 没有图形渲染引擎，不需要维护完整的 Chromium 多进程体系、Blink 布局、绘制、合成、GPU 和媒体栈。它实现 DOM、JavaScript、网络与一部分浏览器 API，让自动化程序可以执行网页逻辑并读取结果。

官方在总计 933 个真实网页的爬取基准中，给出了以下 100 页峰值/耗时结果：

| 官方基准 | Lightpanda | Headless Chrome | 官方差异 |
|---|---:|---:|---:|
| 峰值内存 | 123 MB | 2 GB | 约 16 倍更低 |
| 执行时间 | 5 s | 46 s | 约 9 倍更快 |

这些数据对“抓取页面”有参考价值，但不能外推成“完整浏览器操作快 9 倍”。两者执行的浏览器能力并不等价，尤其 Lightpanda 不做真实布局和绘制。

## 本机实测

环境：macOS 15.6.1、Apple Silicon、Lightpanda `0.3.7`、agent-browser `0.34.0`。测试页包含异步 fetch、500 条动态记录、输入框、下拉框、表单提交、链接跳转和显式 CSS 尺寸。

### 功能与资源

- 动态 DOM、异步 fetch、500 条记录、输入、下拉选择、提交和普通链接跳转均通过。
- 原生 MCP 完成 `tree -> fill -> select -> click -> markdown` 的本地完整链路约 `0.07 s`，结果正确，进程最大 RSS 约 `27.6 MB`。
- 单次带异步等待的页面抓取最大 RSS 约 `27.4 MB`。
- 同一 Lightpanda 进程处理 100 个本地页面约 `2.48 s`，最大 RSS 约 `90.3 MB`。
- 关闭遥测和 core dump 后，5 次本地冷 `fetch` 分别为 `0.04 / 0.03 / 0.05 / 0.04 / 0.04 s`。
- 未关闭遥测时，同一冷命令曾需要约 `1.7-2.4 s`。差异说明默认启动路径会引入明显的额外外部开销；本轮未单独拆分遥测与 core dump 的影响。部署时仍应明确禁用遥测。

这些是本地 fixture 微基准，不代表公网延迟、复杂 SPA 成功率或反爬通过率。

### Puppeteer 与 Playwright

`puppeteer-core 25.8.0` 和 `playwright-core 1.62.1` 均通过以下基础 CDP 路径：

- 连接 CDP、创建 context/page、导航并获取 HTTP 200
- 等待异步 fetch
- 输入、选择、提交
- 链接默认跳转

但两者读取一个声明为 `width: 320px; height: 80px; padding: 10px` 的元素时，都得到：

```json
{
  "rect": { "x": 265, "y": 265, "width": 5, "height": 5 },
  "style": { "width": "5px", "height": "5px", "padding": "" }
}
```

这不是浏览器的真实布局结果。

### 截图是假成功

Puppeteer 和 Playwright 的截图调用都“成功”并生成 1920x1080 PNG，但两个文件与 Lightpanda 源码中的固定占位图逐字节相同。图片内容明确写着：

> No screenshot available, Lightpanda has no graphical rendering engine.

这是接入自动测试时最大的假阳性风险：API 成功不代表产生了真实页面截图。不能只检查命令退出码或文件存在性。

### 与 agent-browser 0.34.0 不兼容

把现有 `agent-browser 0.34.0` 直接连接到 Lightpanda CDP 时，`open`、`tab`、`get url` 和 `snapshot` 都在初始化 target 阶段失败：

```text
CDP error (Target.createTarget): TargetAlreadyLoaded
```

这与 Lightpanda 的公开 issue [#1962](https://github.com/lightpanda-io/browser/issues/1962) 属于同一类 target 生命周期问题。因此现在不能通过替换 Chrome executable/CDP endpoint，让已有 agent-browser skill 和 TeamRun 提示词无改动迁移到 Lightpanda。

### CORS 不等价

测试页从 `127.0.0.1:18181` 请求没有任何 CORS 响应头的 `127.0.0.1:18182`：

| 引擎 | 结果 |
|---|---|
| Lightpanda 0.3.7 | 成功读取 `cross-origin-secret` |
| Chrome + agent-browser 0.34.0 | `TypeError: Failed to fetch` |

Lightpanda README 也把 CORS 标记为未完成。这证明其网页安全模型不是 Chrome 等价实现。用它做抓取可能更方便，但用它验证前端权限边界、跨域错误处理或真实浏览器行为会得到错误结论。

### 等待表达式的可靠性

`--wait-script 'document.querySelector(...).textContent === ...'` 在节点尚未创建时立即因空值解引用失败。加上显式 `document.querySelector(...) !== null && ...` 后才正常等待。Agent 提示词必须要求等待表达式做空值保护，否则动态页面会产生不稳定失败。

## 能力边界

| 场景 | Lightpanda | Chrome + agent-browser | 建议 |
|---|---|---|---|
| 文本、DOM、链接、结构化数据抽取 | 强，速度和内存有优势 | 强 | 可路由到 Lightpanda |
| 大批量页面抓取 | 很有潜力 | 成本较高 | Lightpanda 灰度试点 |
| JS、fetch/XHR、基础表单 | 基础路径可用 | 完整度高 | 目标站点逐一验证 |
| 原生 MCP、多 Agent session | 设计很好，单进程独立 session | agent-browser session 已验证成熟 | Lightpanda 的最佳接入点 |
| 确定性重复任务 | PandaScript 可保存、无模型回放 | agent-browser batch/测试代码 | 两者都适合 |
| 像素、截图、布局、响应式 | 不支持 | 支持 | 必须 Chrome |
| CSS/可见性/点击命中真实性 | 近似且不完整 | 接近用户实际行为 | 必须 Chrome 做最终验收 |
| WebGL/WebGPU、媒体、WASM | 缺失或不完整 | 支持 | 必须 Chrome |
| 复杂 SPA/iframe/多页 | 仍有公开兼容问题 | 成熟 | 默认 Chrome |
| 登录、验证码、反爬、浏览器指纹 | 不追求伪装成 Chrome | 仍可能受限，但更接近真实浏览器 | 不选 Lightpanda |
| 前端 E2E 回归 | 容易假通过 | 合适 | 不替换现有链路 |

## 原生 MCP 的价值

Lightpanda 的原生 MCP 比它的 CDP 兼容层更值得 Agent Tower 评估。当前工具面包含导航、搜索、markdown/html、链接、DOM tree、结构化数据、表单检测、click/fill/select、等待、键盘、cookies、console、evaluate/extract，以及 session 管理。

HTTP MCP 使用 `Mcp-Session-Id` 隔离页面、cookies 和内存，也允许多个 Agent 显式共享同一 session。这与 TeamRun 的并行成员模型比较契合。内置 Agent 还能把探索过程保存为 PandaScript，再以 `lightpanda run` 无模型回放，适合把一次探索固化为低成本批处理。

但这是一套新后端，不是现有 `agent-browser` 命令协议。若接入，应增加明确的浏览器 capability routing，而不是把它伪装成 Chrome 或做静默 fallback。

## 风险

### 1. 兼容性与假阳性

公开 issue 仍覆盖 Playwright/CDP、Accessibility、React、iframe、多 context、多 page、storage state、同文档导航、WebGPU/WASM 等领域。最危险的不是直接报错，而是截图、尺寸、可见性等 API 返回一个看似合法但不真实的结果。

重点跟踪：[#3076](https://github.com/lightpanda-io/browser/issues/3076)、[#1736](https://github.com/lightpanda-io/browser/issues/1736)、[#2173](https://github.com/lightpanda-io/browser/issues/2173)、[#1550](https://github.com/lightpanda-io/browser/issues/1550)、[#1096](https://github.com/lightpanda-io/browser/issues/1096)、[#882](https://github.com/lightpanda-io/browser/issues/882)。

### 2. 安全默认值

- `--block-private-networks` 默认是 `false`。如果 Agent 可访问用户提供的 URL，必须显式开启，否则存在 SSRF/内网探测风险。
- `--obey-robots` 默认是 `false`。批量抓取必须根据产品策略显式开启，并增加域名级速率限制。
- CORS 尚未实现，不能把 Lightpanda 的执行结果视为真实浏览器安全判断。
- 单次响应默认上限高达 1 GiB，生产环境应收紧响应大小、并发、总时限和 V8 heap。
- 遥测默认开启；隐私敏感或生产环境必须设置 `LIGHTPANDA_DISABLE_TELEMETRY=true`。
- core dump 可能包含页面或凭证相关内存，生产环境建议设置 `LIGHTPANDA_DISABLE_CORE_DUMP=1`。

### 3. 许可证

仓库默认许可证是 `AGPL-3.0-only`。调用未修改的独立二进制、修改源码、打包进桌面产品、以及把修改版作为网络服务提供给用户，义务并不完全相同。Agent Tower 若要分发或深度集成，必须先做许可证审查；报告不构成法律意见。

### 4. 运维成熟度

官方仍是 Beta；应预期进程崩溃、页面级不兼容和版本行为变化。服务化时必须有 health check、请求超时、进程重启、session 回收、内存上限、失败重试和 Chrome 降级，但不能静默用两种引擎互相替换，因为两者语义不同。

## Agent Tower 落地建议

### 第一阶段：离线试点

固定 `0.3.7` 和二进制 SHA-256，不跟随 nightly。只选择 10-20 个没有视觉验收要求的固定任务，记录成功率、耗时、RSS、crash、输出一致性和目标站点兼容性。

建议路由条件：

- `text_only = true`
- 不需要截图、PDF、canvas、布局、响应式或视觉断言
- 不需要扩展、WebGL/WebGPU、媒体或强反爬兼容
- 失败后允许显式转交 Chrome，并向 Agent 说明执行引擎已变化

### 第二阶段：增加专用 Provider/能力标签

不要改写现有 agent-browser skill 让它自动猜引擎。新增类似以下能力模型：

```text
browser.chrome: visual, layout, auth, compatibility, e2e
browser.lightpanda: dom, text, extract, bulk, pandascript
```

TeamRun 由 Leader 根据任务约束选择后端；测试工程师的最终验收始终回到 Chrome。Lightpanda 产出的“截图成功”“元素尺寸”“可见性”不得作为通过证据。

### 第三阶段：满足门槛后扩大

建议门槛：固定任务集成功率至少 95%，连续运行无不可回收内存增长，crash 可自动隔离恢复，目标域兼容清单稳定，并完成 AGPL 与遥测/数据治理审查。即使达标，也保留 Chrome 为真值浏览器。

## 最终判断

| 决策 | 建议 |
|---|---|
| 现在替换 agent-browser + Chrome | **否** |
| 作为 Agent Tower 第二浏览器后端 | **是，有限灰度** |
| 最适合的接口 | **原生 MCP + PandaScript** |
| 最适合的任务 | **文本抽取、研究、抓取、批量 DOM、确定性回放** |
| 不应承担的任务 | **真实 E2E、视觉/布局验收、复杂兼容性与安全边界验证** |

## 资料来源

- [Lightpanda README、状态与官方基准](https://github.com/lightpanda-io/browser)
- [0.3.7 release](https://github.com/lightpanda-io/browser/releases/tag/0.3.7)
- [License](https://github.com/lightpanda-io/browser/blob/main/LICENSING.md)
- [MCP server 文档](https://lightpanda.io/docs/open-source/guides/mcp-server)
- [PandaScript 文档](https://lightpanda.io/docs/usage/pandascript)
- [公开 issue 列表](https://github.com/lightpanda-io/browser/issues)

## 测试边界

本次下载并校验了官方 macOS arm64 `0.3.7` 二进制，SHA-256 为 `ae99542d81af23087296ec037abb0d57a57002502f5ff4c1b0b05dfa484b79b8`。测试覆盖本地动态页面、原生 fetch/MCP、CDP、Puppeteer、Playwright、agent-browser 连接、布局、截图和 CORS；没有导入用户登录态，也没有对第三方站点进行压力抓取。官方 Chrome 对比数据已明确标注为官方基准，本次没有在完全相同的 AWS 网络样本上复现。
