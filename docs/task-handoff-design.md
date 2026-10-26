# 任务交接笔记：实施方案

本方案按讨论后确认的简化版本实现，取代早期的两张表、修订记录和四工具草案。开源参考见 [Codex / OpenClaw 调研](task-handoff-memory-research.md)。

## 数据

仅在 `Task` 增加 nullable `handoff` 文本列，保存 Markdown；空值读取为 `""`。同一任务的不同 Workspace/Session 共用正文，子任务独立。详细执行过程继续使用现有会话历史。

共享类型是 `{ taskId: string, content: string }`，正文通过专用接口按需读取，普通任务元数据不附带。正文上限为 32,768（按 JavaScript string.length 计算）。没有额外版本表、日志副本或自动总结任务。

## MCP 与 HTTP

| MCP | 输入 | 对应 HTTP |
| --- | --- | --- |
| `get_task_handoff` | `task_id` | `GET /api/tasks/:id/handoff` |
| `update_task_handoff` | `task_id, old_string, new_string` | `PATCH /api/tasks/:id/handoff`，正文为 `oldString/newString` |

两者返回 `{ taskId, content }`。读取后通过精确文本替换更新笔记：

- old_string 必须匹配一次；缺少匹配或匹配多处时报错。
- 空 old_string 仅允许初始化空笔记。
- 空 new_string 删除匹配片段；插入时传入原片段加新增内容。
- 文本按字面处理，保留空白和换行，不将替换字符串中的 `$&` 等解释为特殊表达式。
- 写入以先前读到的完整正文为数据库条件，检测读写之间的并发变动，不需要额外版本号。
- 发生冲突时重新读取后编辑，不盲目覆盖。

服务端检查任务存在、未删除、项目可写。归档可读；写入复用现有项目保护。浏览器使用 owner 与同源检查，独立 MCP 使用 internal 身份，托管 Agent 限定当前任务；团队成员额外验证 Invocation/Session 绑定、dispatch 未撤销和成员未移除。

## 页面

桌面右侧和手机工作区标签栏增加“交接笔记”，即使尚未创建 Workspace 也可打开。支持 Markdown 展示、编辑、保存、复制和 Ctrl/Cmd + Enter 保存。

正文查询与编辑草稿分开。其他端更新时保留草稿并提示，保存失败也保留；草稿按任务暂存在当前浏览器标签页的 sessionStorage，切换面板后可继续编辑。保存后的刷新复用 task:updated 与重连恢复。

## Agent 上下文

workspace CHAT 回合带入任务笔记和维护指引，提醒 Agent 在重要阶段通过 MCP 更新。正文以 JSON 转义的历史资料传入，不覆盖当前用户请求。启动上下文最多包含 8,000 字符，超出时明确标记并引导读取完整笔记。COMMIT_MSG 与独立对话不注入。

这属于 Agent 主动维护，无法保证异常中断前已保存，也不提供版本回滚。清理 Workspace 保留笔记，删除 Task 时笔记随 Task 删除。

## 验证入口

- 后端真实数据库与 HTTP：`packages/server/src/routes/__tests__/task-handoff.test.ts`。
- MCP 契约：`packages/server/src/mcp/tools/__tests__/tasks.test.ts`。
- 上下文：`packages/server/src/prompts/task-handoff.test.ts`。
- 编辑草稿：`packages/web/src/components/task/__tests__/TaskHandoffPanel.test.tsx`。
- 浏览器：`packages/web/src/components/task/__tests__/task-handoff.fixture.html`；`?mobile=1` 使用移动标签栏。fixture 使用真实组件和隔离内存 API，数据库行为由后端测试验证。
