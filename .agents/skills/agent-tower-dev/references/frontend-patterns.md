# 前端开发模式

## 目录结构

```
packages/web/src/
├── layouts/          # RootLayout, SettingsLayout
├── pages/            # 页面组件
├── components/
│   ├── ui/           # shadcn/ui 基础组件
│   ├── task/         # 任务看板
│   ├── workspace/    # 终端、编辑器、文件树、Git 视图
│   ├── agent/        # Agent 日志、Todo、Token 用量
│   └── mobile/       # 移动端适配
├── hooks/            # TanStack Query hooks
├── stores/           # Zustand stores
├── lib/
│   ├── api-client.ts # HTTP API 封装
│   └── socket/       # Socket.IO 客户端
└── routes/           # react-router-dom 路由配置
```

## TanStack Query Hooks

**Query Keys 范本**：`packages/web/src/hooks/query-keys.ts`
**Hook 范本**：`packages/web/src/hooks/use-tasks.ts`

关键要素：
- query key 集中管理在 `query-keys.ts`，使用 `as const` 断言
- `useQuery` 用 `enabled: !!id` 控制条件查询
- `useMutation` 在 `onSuccess` 中用 `queryClient.invalidateQueries()` 刷新相关缓存
- API 调用通过 `apiClient`（`@/lib/api-client`），自动添加 `/api` 前缀
- 类型从 `@agent-tower/shared` 导入

## API Client

参照 `packages/web/src/lib/api-client.ts`：封装了 `get`/`post`/`put`/`patch`/`delete` 方法。

## Socket.IO 客户端

参照 `packages/web/src/lib/socket/` 目录：提供 hooks 用于订阅 room 和监听事件。

## Zustand Store

参照 `packages/web/src/stores/` 目录下现有 store。用于客户端 UI 状态管理。

## 组件约定

- 函数式组件 + Hooks
- 文件名 PascalCase
- UI 基础组件用 shadcn/ui（`components/ui/`）
- 样式用 TailwindCSS v4
