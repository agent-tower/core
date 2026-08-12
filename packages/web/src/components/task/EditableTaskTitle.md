# EditableTaskTitle 组件

## 功能说明

`EditableTaskTitle` 是一个可编辑的任务标题组件，提供内联编辑功能，支持桌面端和移动端。

## 特性

- ✅ 内联编辑：点击标题或编辑图标直接编辑
- ✅ 键盘操作：Enter 保存，Escape 取消
- ✅ 自动验证：不允许空标题，自动去除空白符
- ✅ 长度限制：200 字符上限，接近限制时显示计数
- ✅ 乐观更新：立即更新 UI，失败后自动回滚
- ✅ 加载状态：显示保存动画
- ✅ 权限控制：只读模式禁用编辑
- ✅ 响应式：支持桌面端和移动端

## API

### Props

```typescript
interface EditableTaskTitleProps {
  /** 任务 ID */
  taskId: string
  /** 当前标题 */
  title: string
  /** 是否只读（已归档项目） */
  readOnly?: boolean
  /** 标题更改回调 */
  onTitleChange?: (newTitle: string) => void
  /** 容器类名 */
  className?: string
  /** 标题文本类名 */
  titleClassName?: string
  /** 紧凑模式（移动端） */
  compact?: boolean
}
```

## 使用示例

### 桌面端使用

```tsx
import { EditableTaskTitle } from '@/components/task'

function TaskDetail({ task }) {
  return (
    <div>
      <EditableTaskTitle
        taskId={task.id}
        title={task.title}
        readOnly={task.projectArchivedAt !== null}
      />
    </div>
  )
}
```

### 移动端使用

```tsx
import { EditableTaskTitle } from '@/components/task'

function MobileTaskDetail({ task }) {
  return (
    <div>
      <EditableTaskTitle
        taskId={task.id}
        title={task.title}
        readOnly={task.projectArchivedAt !== null}
        titleClassName="text-[13px] font-bold"
        compact
      />
    </div>
  )
}
```

### 带回调使用

```tsx
import { EditableTaskTitle } from '@/components/task'

function TaskCard({ task }) {
  const handleTitleChange = (newTitle: string) => {
    console.log('Title changed:', newTitle)
    // 可以在这里触发其他业务逻辑
  }

  return (
    <EditableTaskTitle
      taskId={task.id}
      title={task.title}
      onTitleChange={handleTitleChange}
    />
  )
}
```

## 交互流程

1. **查看模式**
   - 显示任务标题
   - 鼠标悬停显示编辑图标
   - 点击标题或编辑图标进入编辑模式

2. **编辑模式**
   - 显示文本输入框
   - 自动聚焦并选中全部文本
   - 显示保存/取消按钮
   - 接近字符限制时显示计数

3. **保存操作**
   - 按 Enter 键保存
   - 点击保存按钮
   - 点击外部区域自动保存
   - 显示加载动画

4. **取消操作**
   - 按 Escape 键取消
   - 点击取消按钮
   - 恢复原标题

## 验证规则

- 标题不能为空或纯空白
- 最大长度 200 字符
- 自动去除首尾空白
- 超过 180 字符时显示警告
- 如果标题没有变化，不发送请求

## 错误处理

- 验证失败：直接退出编辑模式，不发送请求
- 网络失败：显示错误提示，保留编辑内容
- 请求失败：自动回滚到原标题

## 后端集成

组件使用 `useUpdateTask` hook 调用以下 API：

```
PUT /api/tasks/:id
Body: { title: string }
```

后端会自动处理：
- 标题规范化（压缩空白符）
- 长度截断（最大 200 字符）
- 自动拆分（超过 240 字符时拆分到 description）

## 实现细节

### 状态管理

- `isEditing`: 编辑状态
- `editValue`: 编辑中的值
- `isHovered`: 悬停状态

### React Query 集成

使用 `useUpdateTask` mutation 处理：
- 乐观更新缓存
- 自动重新获取相关查询
- 错误回滚

### 无障碍支持

- 键盘导航（Enter/Escape）
- 焦点管理
- 语义化 HTML

## 注意事项

1. **只读模式**：归档或删除的项目自动禁用编辑
2. **字符计数**：接近限制时自动显示，不需要手动控制
3. **点击外部保存**：自动保存，无需手动处理
4. **并发编辑**：后端返回最新数据，WebSocket 实时同步

## 相关组件

- `TaskDetail`: 桌面端任务详情页
- `MobileTaskDetail`: 移动端任务详情页
- `useUpdateTask`: 更新任务 hook
