# 房间译文 Socket 登录到期回归

从仓库根运行：

```sh
pnpm exec vitest run --config scripts/acceptance/room-socket-expiry/vitest.config.mts
```

使用真实 Socket.IO WebSocket、生产 authMiddleware/Gateway/TranslationService 与临时 SQLite，覆盖 Cookie 自然到期、最终鉴权等待、退订/新订阅意图、generation 轮换、密码关闭、Session 兼容、TEAM_USER 通知及数据库 scope 拒绝。默认测试当前仓库；需要固定版本核对时，可用 `ROOM_SOCKET_EXECUTION_ROOT` 指向含独立依赖的隔离导出目录。

仅在签发短期限 Cookie 的瞬间投影签发时钟，校验与到期等待使用真实时间。查询等待门原样返回真实 SQLite 结果，不伪造鉴权通过。无翻译 worker、Provider 或用户投递；测试结束断开客户端、销毁 Gateway/Service、关闭 listener/Prisma 并移除临时目录。无需长期 workspace service。
