---
name: github-desktop-release
description: "通过 GitHub Actions 发布 Agent Tower 桌面端多平台安装包。当用户要求发布 GitHub release、触发 GitHub 自动打包、发桌面版、构建 macOS/Windows/Linux 安装包或处理桌面包 CI 发布时使用此 skill。"
---

# GitHub Desktop Release

用于通过 `.github/workflows/build-desktop.yml` 触发桌面端多平台打包，并生成 GitHub draft release。

## 触发机制

- `push` tag 且 tag 匹配 `v*`：自动构建 macOS/Windows/Linux 桌面包，并创建或更新 draft GitHub Release。
- `workflow_dispatch`：只手动构建并上传 Actions artifacts，不创建 GitHub Release。

正式发布桌面包时优先用 tag push，不要只手动跑 Action。

## 发布前检查

1. 确认工作区状态：

```bash
git status --short
```

2. 确认当前版本来源：

- npm/server 版本在 `packages/server/package.json`
- desktop 包版本在 tag workflow 中由 tag 临时写入 `packages/desktop/package.json`
- tag 必须是 semver 形式，例如 `v0.5.2-beta.6`

3. 构建前本地至少验证：

```bash
pnpm --filter @agent-tower/server build
pnpm --filter @agent-tower/desktop run package:prepare
```

如改过 Linux metadata 或 Electron Builder 配置，再跑：

```bash
pnpm --filter @agent-tower/desktop run package:linux
```

## 触发 GitHub 自动打包

1. 创建并推送 tag：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

如果 tag 已存在且需要重发，先和用户确认。不要擅自删除或强推 tag。

2. 查看 workflow：

```bash
gh run list --workflow "Build Desktop" --limit 5
gh run watch <run-id>
```

3. 查看产物：

```bash
gh run download <run-id> --dir desktop-artifacts
```

4. 查看 draft release：

```bash
gh release view vX.Y.Z
```

## GitHub Release 行为

tag push 成功后 workflow 会：

- 在 `macos-latest` 构建 macOS arm64 DMG
- 在 `windows-latest` 构建 Windows x64 NSIS installer 和 portable exe
- 在 `ubuntu-latest` 构建 Linux x64 AppImage 和 deb
- 上传 Actions artifacts，保留 14 天
- 创建或更新 draft GitHub Release，并上传所有平台产物

发布 draft release 前，检查产物齐全后再执行：

```bash
gh release edit vX.Y.Z --draft=false
```

预发布版本可标记 prerelease：

```bash
gh release edit vX.Y.Z --prerelease --draft=false
```

## 常见问题

- Prisma 类型错误：确认 `packages/server/package.json` 的 `build` 会先跑 `pnpm run db:generate`。
- Windows `cp` 不存在：server build 资产复制应使用 Node 脚本，不用 Unix-only `cp`。
- Linux deb 报 `Please specify project homepage`：`packages/desktop/package.json` 顶层需要 `homepage`。
- Linux WM_CLASS warning：顶层 `desktopName` 配合 `build.linux.syncDesktopName: true`。
- macOS 包目前未签名/未公证；正式分发前需要 Developer ID signing/notarization。
- Windows 包目前未签名；正式分发前需要代码签名。
