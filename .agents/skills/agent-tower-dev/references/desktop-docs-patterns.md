# Desktop 与公开文档

## npm CLI 发布

`scripts/build-publish.mjs` 组装全局 CLI 发布包。保持 Prisma 安装只有一个 client 生成者：发布包 bundled `@prisma/client` 时删除其 `generate`、`postinstall` 和可选 `prisma` peer，由根包 postinstall 使用精确同版本的普通 `prisma` dependency 生成目标平台 client；不要同时启用两处 generate。Pi Runtime 必须先用隔离 npm nested install 物化完整 dependency tree，再作为 bundled dependency 打包；不能直接复制 pnpm symlink，也不能依赖最终全局安装重新解析 Pi 的 shrinkwrap。发布前运行 `pnpm build:publish` 和 `pnpm publish:smoke`，从最终 tarball 验证隔离全局安装、client 语法、模块加载、query engine，并实际执行 bundled `pi --version`。

## Electron

`packages/desktop` 复用现有 server/web。主进程选择 workspace 或 packaged runtime，校验 bundled assets，启动 loopback server，等待 health 后加载同源 Web UI，并在退出或崩溃时清理子进程。

保持这些边界：

- packaged 默认 shared data，开发壳默认 isolated；测试使用独立 user data/data dir。
- packaged runtime 在所有平台复制并使用构建环境中满足仓库最低版本的 bundled Node，同时携带 server、web 和 MCP；不要回退到 Electron 内嵌 Node，也不依赖全局 CLI。
- 后端只绑定 loopback，窗口只加载预期本地 origin。
- startup failure、early exit 和正常退出都有清理；日志使用 `log-redaction.ts`。
- 路径、process kill 和 executable 选择兼容 Windows/macOS/Linux。

runtime 内容变化时检查 `prepare-runtime.mjs`、`extraResources` 和平台打包 target，并运行对应 desktop build/smoke/acceptance；Pi Runtime 检查必须实际执行 bundled `pi --version`，只 import 包不足以证明可执行依赖完整。

## Docusaurus

公开文档位于 `packages/docs-site/docs/`，内部计划和专项排障位于顶层 `docs/`；`design/agent-tower` 是历史原型。行为变化更新对应 guide/reference/integration 页面；新增页面同步 `sidebars.ts`。

以代码、package scripts、shared events 和 route registration 为真源。示例不包含真实 token、密码、用户绝对路径或 TeamRun identity。不要编辑生成的 `packages/docs-site/build/`；完成后运行 `pnpm docs:build`。
