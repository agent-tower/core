# Desktop 与公开文档

## Electron

`packages/desktop` 复用现有 server/web。主进程选择 workspace 或 packaged runtime，校验 bundled assets，启动 loopback server，等待 health 后加载同源 Web UI，并在退出或崩溃时清理子进程。

保持这些边界：

- packaged 默认 shared data，开发壳默认 isolated；测试使用独立 user data/data dir。
- packaged runtime 使用 bundled Node、server、web 和 MCP，不依赖全局 CLI。
- 后端只绑定 loopback，窗口只加载预期本地 origin。
- startup failure、early exit 和正常退出都有清理；日志使用 `log-redaction.ts`。
- 路径、process kill 和 executable 选择兼容 Windows/macOS/Linux。

runtime 内容变化时检查 `prepare-runtime.mjs`、`extraResources` 和平台打包 target，并运行对应 desktop build/smoke/acceptance。

## Docusaurus

公开文档位于 `packages/docs-site/docs/`，内部计划和专项排障位于顶层 `docs/`；`design/agent-tower` 是历史原型。行为变化更新对应 guide/reference/integration 页面；新增页面同步 `sidebars.ts`。

以代码、package scripts、shared events 和 route registration 为真源。示例不包含真实 token、密码、用户绝对路径或 TeamRun identity。不要编辑生成的 `packages/docs-site/build/`；完成后运行 `pnpm docs:build`。
