# Desktop、发布产物与公开文档

## npm CLI 发布包

`scripts/build-publish.mjs` 构建 shared/server/web，并把全局 CLI 包组装到 `packages/server/publish/`；版本来自 server package，入口是 `agent-tower` 与 `agent-tower-mcp`。npm 包与 Electron runtime 使用不同组装流程，修改依赖时分别核对，不能以一种构建通过推断另一种可运行。

- Prisma 安装保留唯一 client 生成者：bundled `@prisma/client` 移除 `generate`、`postinstall` 和可选 `prisma` peer，由根 postinstall 使用精确同版本的普通 `prisma` dependency 生成目标平台 client。`packages/server/scripts/postinstall.js` 将 cwd、`INIT_CWD` 和 Prisma CLI 解析固定到安装包根，避免全局安装时污染 consumer 项目。
- Pi 先通过隔离 npm nested install 物化完整依赖树，再作为 bundled dependency 打包。不能直接复制 pnpm symlink，也不能指望最终安装重新还原 Pi shrinkwrap；变更 Pi/ACP 依赖同时检查 server package、lockfile、组装与 smoke。
- node-pty 携带多平台 prebuilds，避免最终安装重新 node-gyp；cloudflared 只 bundle JS wrapper，不携带发布机 binary，其目标平台 binary 由服务首次启动 tunnel 时获取。保持两者安装脚本裁剪与可执行权限处理。
- `scripts/smoke-publish-install.mjs --tarball <path>` 复用已有本地 tarball 在临时 prefix 执行全局安装，不要求构建目录且保留输入包；无参数时仍会从 publish 目录临时打包。consumer 必须是独立且有 `package.json` 的目录。验证 client 语法/模块加载/query engine、无 consumer `.prisma` 泄漏，以及实际执行 bundled `pi --version`。

相关验证是 `pnpm build:publish`、`pnpm publish:smoke --tarball <path>`；脚本回归使用 `pnpm exec vitest run packages/server/scripts/smoke-publish-install.test.ts`，不联网安装。真实发布只 pack 一次，验证、发布和交付复用同一个 tarball，快速 beta / 完整验证按 publish skill 分级；依赖或安装链路变化不能跳过完整安装。仅改此指导不需要构建或安装。真正的 npm/GitHub 发布按用户授权使用仓库对应发布 skill，构建本身不发布。

## Electron 运行与退出

`packages/desktop/src/main.ts` 是 Electron 主进程，复用 server CLI 与 web dist，没有单独的桌面业务 API。开发模式使用 workspace dist 与 `AGENT_TOWER_DESKTOP_NODE`/PATH Node；packaged 使用 `resources/runtime/node`、`runtime/server`、`runtime/web`。启动校验 assets，选择可用 loopback 端口，等待 `/api/health` 后加载 Web UI。

- `data-mode.ts` 定义 packaged 默认 shared、开发默认 isolated；`AGENT_TOWER_DESKTOP_DATA_MODE` 可显式覆盖。shared 沿用 CLI 的 data-dir 合约，isolated 传入 `<Electron userData>/data`。MCP 配置必须使用相同 bundled Node、MCP entry 和 data dir，才能发现本次后端端口。
- packaged 在所有平台使用构建环境中满足根 `engines.node` 的独立 Node，把其目录加入 PATH 并设置 `AGENT_TOWER_NODE_RUNTIME`；清除 `ELECTRON_RUN_AS_NODE`。不要回退到 Electron 内嵌 Node 或全局 CLI。
- 后端绑定 `127.0.0.1`；BrowserWindow 设置 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。当前只是初始加载本地 URL，不能把它描述为已实现导航/新窗口 origin allowlist；修改外链、窗口或 preload 时以实际 webContents handler 为准。
- Web 通过 query 参数识别桌面平台与 integrated titlebar，联查 `packages/web/src/lib/desktop-titlebar.tsx` 和 RootLayout；macOS/Windows 的系统按钮占位不能影响普通浏览器。
- 普通退出由 `before-quit.ts` 挡住 Electron quit，`backend-shutdown.ts` 通过随 spawn 建立的私有 IPC 发送 shutdown 并等待真实 `exit`，让 backend 清理所有进程 owner。Unix 无 IPC 时可回退 SIGTERM；Windows 不能把 `child.kill(SIGTERM)` 当作可执行 JS 清理的通知。发送失败需重试，普通退出不加固定时间后的 SIGKILL。开发 launcher 复用相同协议。
- 后端已启动后崩溃，`main.ts` 的 recovery owner 会用同一 data 配置启动 replacement backend，再走正常关闭以回收持久化进程所有权；这不是恢复 UI 服务。每个失败启动保留 child，等待其真实退出后才允许再次 recovery；并发 quit、health timeout 和 child error 不能覆盖仍存活的旧 owner。
- 持久化桌面日志使用 `log-redaction.ts` 的文本和 metadata 脱敏；路径、可执行名与进程操作兼容 Windows/macOS/Linux。

## Desktop 组装与验收

`packages/desktop/scripts/prepare-runtime.mjs` 复制当前 Node，使用 hoisted `pnpm deploy --legacy --prod` 组装 server，应用 `packages/server/scripts/patch-claude-agent-acp.mjs`，验证生产依赖和生成 Prisma Client/engine，最后复制 web dist。除 `.bin` 外 runtime dependency tree 不得含 symlink；修改部署方式时保留这项校验和 node-pty spawn-helper 执行权限。

runtime check 使用 bundled Node 解析 MCP/ACP/Prisma，并真正运行 bundled Claude、Codex、Pi 的 `--version`。只 import 模块不足以证明其可执行依赖完整。变更 assets 或依赖还要核对 desktop package 的 `extraResources`、平台 target 与 server package 的发布 files。

从仓库根目录按风险选择：

```bash
pnpm exec vitest run packages/desktop/test
pnpm --filter @agent-tower/desktop build
pnpm desktop:spike
pnpm desktop:package:dir
pnpm desktop:package:smoke
pnpm desktop:package:acceptance
```

`desktop:spike` 会构建依赖后启动开发壳；`package:dir` 重新构建并准备本机 unpacked app。smoke/acceptance 期待已有 packaged output，使用 `packages/desktop/scripts/packaged-app-env.mjs` 创建临时 HOME、userData、data dir，并直接启动 app binary；普通 `open` 会采用 shared 数据策略，不能替代隔离验收。

smoke 覆盖 health、Socket `/events`、独立 PTY 创建/删除和 UI 加载，不覆盖真实 Agent 对话或完整终端交互。smoke/acceptance harness 的超时强退是测试清理策略，不能作为普通应用退出已正确等待的证据；退出语义使用 `test/backend-shutdown.test.ts` 与 `test/before-quit.test.ts` 并在相关改动时验证实际关闭。

## CI 与版本边界

- `.github/workflows/build-desktop.yml` 按 macOS arm64、Windows x64、Linux x64 原生 runner 构建 DMG、NSIS/portable、AppImage/deb；目前 packaged smoke 仅在 Windows CI 步骤运行，不能声称三平台都有同等验收。
- `v*` tag push 将 tag 版本写入 desktop package，全部平台构建完成后另一个 job 创建/更新 draft GitHub Release；手动 dispatch 只生成 workflow artifacts。workflow 使用 `package:*` 的 `--publish never`，不是直接执行 `package:*:publish`。旧 README 发布描述可能落后于 workflow，以 YAML 为准。
- server/npm、desktop、docs package 版本职责不同，不为普通功能修改同步改全仓版本。现有桌面构建未配置签名/公证或自动更新；release artifact 不代表这些能力已存在。

## Docusaurus

公开文档在 `packages/docs-site/docs/`，内部计划和专项排障在顶层 `docs/`；`design/agent-tower` 是历史原型。行为变化更新对应 guide/reference/integration 页面，新增页面同步显式 `sidebars.ts`。示例以代码、package scripts、shared events 和 route registration 为真源，避免真实 token、密码、个人绝对路径或 TeamRun identity。

站点使用 `docusaurus.config.ts` 与两个本地 webpack plugin 处理 SSR/Babel 模块解析边界。依赖/构建配置调整时先读这三处，避免移除仅生产 SSR 才需要的修正。不要编辑生成的 `build/` 或 `.docusaurus/`；内容/导航/站点构建变更运行 `pnpm docs:build`，检查 broken-link 报错和 Markdown link 警告。

`.github/workflows/deploy-docs.yml` 在 main 的相关路径变化或 dispatch 时发布 `packages/docs-site/build` 到独立 `agent-tower.github.io` 仓库。该 workflow 自行指定 pnpm 版本，未自动沿用根 `packageManager`；变更依赖或 lockfile 时同时核对，不能从旧 CI 设置推导本地应降级 pnpm。
