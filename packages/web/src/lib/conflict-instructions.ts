import { ConflictOp } from '@agent-tower/shared'

type GitOperationKind = 'idle' | 'rebase' | 'merge'
type MergeStrategy = 'squash' | 'no_ff'

export interface ConflictInstructionContext {
  workspaceId?: string
  worktreePath?: string
  operation?: GitOperationKind
  mergeAborted?: boolean
  mergeStrategy?: MergeStrategy
  sourceWorkspaceId?: string
  targetWorkspaceId?: string
  sourceWorktreePath?: string
  targetWorktreePath?: string
}

export interface TeamRunConflictMessageContext extends ConflictInstructionContext {
  sourceBranch: string
  targetBranch: string
  conflictedFiles: string[]
  conflictOp: ConflictOp
}

function formatFileList(conflictedFiles: string[]): string {
  return conflictedFiles.length > 0
    ? conflictedFiles.map((file) => `- ${file}`).join('\n')
    : '- 未获取到冲突文件列表'
}

function formatOptionalContext(context?: ConflictInstructionContext): string[] {
  if (!context) return []

  const lines: string[] = []
  if (context.workspaceId) lines.push(`- Workspace: \`${context.workspaceId}\``)
  if (context.worktreePath) lines.push(`- Worktree: \`${context.worktreePath}\``)
  if (context.sourceWorkspaceId) lines.push(`- Source workspace: \`${context.sourceWorkspaceId}\``)
  if (context.targetWorkspaceId) lines.push(`- Target workspace: \`${context.targetWorkspaceId}\``)
  if (context.sourceWorktreePath) lines.push(`- Source worktree: \`${context.sourceWorktreePath}\``)
  if (context.targetWorktreePath) lines.push(`- Target worktree: \`${context.targetWorktreePath}\``)
  if (context.operation && context.operation !== 'idle') lines.push(`- Git 状态: \`${context.operation}\``)
  if (context.mergeStrategy) lines.push(`- Merge strategy: \`${context.mergeStrategy}\``)
  if (context.mergeAborted) lines.push(`- Merge state: conflict detected and already aborted by Agent Tower`)
  return lines
}

function buildMergeSteps(sourceBranch: string, context?: ConflictInstructionContext): string[] {
  if (!context?.mergeAborted) {
    return [
      `1. 打开上述冲突文件，解决所有冲突标记（\`<<<<<<<\`、\`=======\`、\`>>>>>>>\`）`,
      `2. 对每个已解决的文件执行 \`git add <file>\``,
      `3. 执行 \`git commit\` 完成合并`,
    ]
  }

  const mergeCommand = context.mergeStrategy === 'squash'
    ? `git merge --squash --no-commit ${sourceBranch}`
    : `git merge --no-ff ${sourceBranch}`
  const finishCommand = context.mergeStrategy === 'squash'
    ? '`git commit`'
    : '`git merge --continue` 或 `git commit`'

  return [
    `1. 注意：Agent Tower 检测到 merge 冲突后已经执行 abort，当前不要假设存在冲突标记或 \`MERGE_HEAD\``,
    `2. 切换到 Target worktree / Target branch 上下文，确认工作区干净`,
    `3. 重新执行 \`${mergeCommand}\` 复现冲突`,
    `4. 打开上述冲突文件，解决所有冲突标记（\`<<<<<<<\`、\`=======\`、\`>>>>>>>\`）`,
    `5. 对每个已解决的文件执行 \`git add <file>\``,
    `6. 执行 ${finishCommand} 完成合并`,
  ]
}

function describeMergeIntent(context: TeamRunConflictMessageContext): string {
  if (!context.mergeAborted) {
    return `请确认当前 Git 状态，解决所有冲突标记，完成必要的 \`git add\` 与后续 merge 提交，然后说明处理结果。`
  }

  const target = context.targetWorktreePath
    ? `目标 worktree \`${context.targetWorktreePath}\``
    : `目标分支 \`${context.targetBranch}\``
  const mergeCommand = context.mergeStrategy === 'squash'
    ? `git merge --squash --no-commit ${context.sourceBranch}`
    : `git merge --no-ff ${context.sourceBranch}`

  return `Agent Tower 已在检测到冲突后 abort 了 merge；请在${target}中确认工作区干净，重新执行 \`${mergeCommand}\` 复现冲突，解决后完成提交并汇报验证结果。`
}

/**
 * 根据冲突上下文生成结构化的 AI Agent 冲突解决指令
 */
export function buildResolveConflictsInstructions(
  sourceBranch: string,
  targetBranch: string,
  conflictedFiles: string[],
  conflictOp: ConflictOp,
  context?: ConflictInstructionContext
): string {
  const fileList = formatFileList(conflictedFiles)
  const contextLines = formatOptionalContext(context)

  if (conflictOp === ConflictOp.REBASE) {
    return [
      `## Rebase 冲突解决`,
      ``,
      `在将分支 \`${sourceBranch}\` rebase 到 \`${targetBranch}\` 时发生了冲突。`,
      ...(contextLines.length > 0 ? [``, `### 上下文`, ...contextLines] : []),
      ``,
      `### 冲突文件`,
      fileList,
      ``,
      `### 解决步骤`,
      `1. 打开上述冲突文件，解决所有冲突标记（\`<<<<<<<\`、\`=======\`、\`>>>>>>>\`）`,
      `2. 对每个已解决的文件执行 \`git add <file>\``,
      `3. 执行 \`git rebase --continue\` 继续 rebase 流程`,
    ].join('\n')
  }

  return [
    `## Merge 冲突解决`,
    ``,
    `在将分支 \`${sourceBranch}\` 合并到 \`${targetBranch}\` 时发生了冲突。`,
    ...(contextLines.length > 0 ? [``, `### 上下文`, ...contextLines] : []),
    ``,
    `### 冲突文件`,
    fileList,
    ``,
    `### 解决步骤`,
    ...buildMergeSteps(sourceBranch, context),
  ].join('\n')
}

export function buildTeamRunResolveConflictsMessage(context: TeamRunConflictMessageContext): string {
  const opLabel = context.conflictOp === ConflictOp.REBASE ? 'Rebase' : 'Merge'
  const fileList = formatFileList(context.conflictedFiles)
  const contextLines = [
    ...formatOptionalContext(context),
    `- Source branch: \`${context.sourceBranch}\``,
    `- Target branch: \`${context.targetBranch}\``,
    `- Conflict type: \`${context.conflictOp}\``,
  ]

  return [
    `## 请求处理 ${opLabel} 冲突`,
    ``,
    `用户点击了“AI 辅助解决”，请在对应 workspace 中处理当前 ${opLabel} 冲突，并在 Team Room 汇报处理结果和验证情况。`,
    ``,
    `### 上下文`,
    ...contextLines,
    ``,
    `### 冲突文件`,
    fileList,
    ``,
    `### 用户意图`,
    context.conflictOp === ConflictOp.REBASE
      ? `请确认当前 Git 状态，解决所有冲突标记，完成必要的 \`git add\` 与后续 \`git rebase --continue\`，然后说明处理结果。`
      : describeMergeIntent(context),
  ].join('\n')
}

export type ResolveConflictAiAction =
  | { type: 'team_room'; message: string }
  | { type: 'session'; sessionId: string; message: string }
  | { type: 'none' }

export interface ResolveConflictAiActionInput extends TeamRunConflictMessageContext {
  teamRunId?: string
  currentSessionId?: string
  selectedSessionId?: string
}

export function buildResolveConflictAiAction(input: ResolveConflictAiActionInput): ResolveConflictAiAction {
  if (input.teamRunId) {
    return {
      type: 'team_room',
      message: buildTeamRunResolveConflictsMessage(input),
    }
  }

  const sessionId = input.currentSessionId || input.selectedSessionId
  if (!sessionId) return { type: 'none' }

  return {
    type: 'session',
    sessionId,
    message: buildResolveConflictsInstructions(
      input.sourceBranch,
      input.targetBranch,
      input.conflictedFiles,
      input.conflictOp,
      input,
    ),
  }
}
