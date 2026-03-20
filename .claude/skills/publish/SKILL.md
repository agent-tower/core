---
name: publish
description: "发布 agent-tower 包到 npm registry。当用户要求发布、publish、更新 npm 包、发新版本时使用此 skill。"
---

# Publish to npm

## 流程

### 1. 版本号处理

- 读取 `packages/server/package.json` 中的当前版本号
- 询问用户选择版本升级类型：
  - **patch** (x.y.Z): bug 修复、小改动（默认）
  - **minor** (x.Y.0): 新功能
  - **major** (X.0.0): 破坏性变更
  - 或用户直接指定版本号
- 更新 `packages/server/package.json` 中的 `version` 字段

### 2. 构建

```bash
node scripts/build-publish.mjs
```

此脚本会：清理旧产物 → 构建 shared → server → web → 组装到 `packages/server/publish/`

### 3. 发布

```bash
cd packages/server/publish && npm publish
```

### 4. 验证

发布成功后告知用户新版本号。

## 注意事项

- 版本号冲突会返回 403，需升级版本号重试
- 发布包约 8MB，含 bundled deps（@prisma/client, prisma, @agent-tower/shared）
- 确保 npm 已登录（`npm whoami`）
