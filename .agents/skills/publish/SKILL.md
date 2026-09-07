---
name: publish
description: "发布 agent-tower 包到 npm registry。当用户要求发布、publish、更新 npm 包、发新版本时使用此 skill。"
---

# Publish to npm

## 1. 集中预检与版本处理

- 集中检查 Git 状态、server 版本、`npm whoami`、registry dist-tags 和目标版本是否已存在，记录发布前的 `latest`。
- 用户明确要求“新 beta”时，递增当前 beta 系列的序号，并与 registry 核对；不再询问 patch/minor/major。新系列或升级范围不明确时才询问。明确版本号优先；转正式版去掉 prerelease 后缀。
- 更新 `packages/server/package.json` 的版本。发布前必须提交版本变更并保持源码工作区干净；需要 Git 提交授权时在此一次询问，已有明确授权则不重复问。
- 记录构建所用的提交 SHA。不要假设 npm 会自动写入 `gitHead`，来源追溯使用提交 SHA、安装包 integrity 和验证记录。

## 2. 按变更选择验证等级

比较**上一次完整冒烟通过的提交与本次提交**，不能只检查未提交 diff，也不能把 npm beta 标签自动视为验证基线。基线来自可信的发版任务记录或 CI 结果，包含提交、验证环境和结果；找不到基线、基线不适用或影响不明时走完整验证。

| 等级 | 条件 | 必做验证 |
| --- | --- | --- |
| 快速 beta | 仅 UI/业务逻辑调整，生产依赖与安装链路未变，有适用的完整验证基线 | 构建、包内容检查、相关回归测试；可省略全新全局安装 |
| 完整验证 | 生产依赖/相关锁文件、打包脚本、postinstall、Prisma、原生模块、Pi/ACP 或 CLI 启动链路变化；或无可信基线 | 快速检查 + 最终 tarball 的隔离全局安装冒烟 |
| 正式版 | 非 prerelease 发布 | 完整验证 + macOS、Windows、Linux 安装和 CLI 启动验证 |

- 比较 package.json 时忽略纯 `version` 变化；锁文件改动无法确认仅影响开发依赖时按完整验证处理。
- 快速验证不等价于新机器安装验证，不能在后续发布中充当完整基线；定期完整验证或用户要求完整检查时不得走快速模式。
- cloudflared 的真实首次下载检查仅在相关依赖/下载逻辑变化、正式版或定期完整检查时执行，不随每个 beta 重复联网下载。

## 3. 构建、打包一次并复用

从仓库根目录执行：

```bash
pnpm build:publish
npm pack ./packages/server/publish --json --pack-destination ./packages/server/publish > ./packages/server/publish/pack-result.json
```

从 `pack-result.json` 读取 filename、version、integrity 和 files，后续检查、安装、发布和交付均复用**这一个 tarball**。不要额外运行 `npm pack --dry-run`，不要从目录再次发布，也不要为了交付重新打包。已有有效 tarball 时，安装/发布网络失败不触发重新打包；产物内容修改后则必须重新构建、打包和验证。

包内容检查保留以下不变量：
- CLI/MCP 入口、前端和 Prisma schema 齐全，版本正确，不夹带 `.env`、数据库或发布机运行数据。
- bundled `@prisma/client` 移除 generate/postinstall 和可选 prisma peer；普通 dependency 的 Prisma CLI 与 Client 精确同版本，由根 postinstall 唯一生成本机 Client。包内不含 `node_modules/prisma` 或预生成的 `node_modules/.prisma`。
- Pi 的完整运行时依赖树和 node-pty 多平台 prebuilds 齐全；cloudflared 仅包含无 postinstall 的 JS wrapper，不含 `node_modules/cloudflared/bin`。

仅完整验证执行（将 `<version>` 替换为本次版本，文件名以 pack 结果为准）：

```bash
pnpm publish:smoke --tarball ./packages/server/publish/agent-tower-<version>.tgz
```

该模式不再打包、不依赖构建目录，且不会删除传入的 tarball。保留原有 Prisma 语法/模块加载/query engine、consumer 隔离和 Pi 可执行性检查，不加 `--ignore-scripts` 绕过安装验证。无参数 `pnpm publish:smoke` 仍兼容本地临时打包测试，正常发布不要使用这个重复打包路径。

## 4. 发布与一次性核验

确认验证通过、源码仍干净后，发布同一个 tarball：

```bash
npm publish ./packages/server/publish/agent-tower-<version>.tgz --tag beta
npm view agent-tower@<version> version dist-tags dist.integrity --json
```

- 正式版显式使用 `--tag latest`；其他 prerelease 使用已确认的标签，不依赖 npm 默认 tag。
- 核对精确版本、目标 dist-tag 和 integrity；beta 发布时 `latest` 应保持预检值。registry 可见性延迟时只重试查询，不重复发布。
- 最终摘要记录版本、源码 SHA、验证等级/结果、Node/npm 版本与平台、tarball integrity。完整验证成功的记录才可作为后续基线；registry 无 `gitHead` 不触发重打包或新版本发布。
- 403 不一定是版本冲突：先区分版本已存在、权限和认证问题。失败时报告原因，不自动改版本重发。
- 长安装等待终态输出，不短间隔轮询、重复查 registry 或重读全部脚本；只在失败或异常长时间无进展时读取相关日志。
