import { useState, useEffect, useMemo } from 'react'
import { RotateCcw, Trash2, AlertTriangle, ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useProjects, useUpdateProject, useArchiveProject, useRestoreProject } from '@/hooks/use-projects'
import { Button } from '@/components/ui/button'
import { FilePathListInput } from '@/components/ui/file-path-list-input'
import { QuickCommandsEditor } from '@/components/ui/quick-commands-editor'
import { Modal } from '@/components/ui/modal'
import { FolderPicker } from '@/components/ui/folder-picker'
import type { Project, QuickCommand } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { SettingsPageContainer } from '@/components/settings/SettingsSection'

interface FormState {
  copyFiles: string[]
  setupScript: string
  quickCommands: QuickCommand[]
}

function parseCopyFiles(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function parseQuickCommands(raw: string | null | undefined): QuickCommand[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function getProjectDotClass(project: Pick<Project, 'color'>): string {
  if (typeof project.color !== 'string' || project.color.trim() === '') return 'bg-neutral-400'
  if (project.color.startsWith('bg-')) return project.color
  if (project.color.startsWith('text-')) return project.color.replace('text-', 'bg-')
  return 'bg-neutral-400'
}

export function ProjectSettingsPage() {
  const { t } = useI18n()
  const { data: projectsData, isLoading } = useProjects({ limit: 100, includeArchived: true })
  const updateProject = useUpdateProject()
  const archiveProject = useArchiveProject()
  const restoreProject = useRestoreProject()

  const [selectedId, setSelectedId] = useState<string>('')
  const [pendingSelectedId, setPendingSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({ copyFiles: [], setupScript: '', quickCommands: [] })
  const [dirty, setDirty] = useState(false)
  const [projectActionProjectId, setProjectActionProjectId] = useState<string | null>(null)
  const [isArchiveProjectOpen, setIsArchiveProjectOpen] = useState(false)
  const [isRestoreProjectOpen, setIsRestoreProjectOpen] = useState(false)
  const [deleteProjectWithRepo, setDeleteProjectWithRepo] = useState(false)
  const [confirmDeleteProjectRepo, setConfirmDeleteProjectRepo] = useState(false)
  const [restoreProjectRepoPath, setRestoreProjectRepoPath] = useState('')
  const [mobileShowDetail, setMobileShowDetail] = useState(false)

  const projects: Project[] = projectsData?.data ?? []
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects])
  const archivedProjects = useMemo(() => projects.filter((p) => p.archivedAt), [projects])
  const selected = activeProjects.find((p) => p.id === selectedId)
  const selectedProjectForAction = useMemo(
    () => projects.find((p) => p.id === projectActionProjectId) ?? null,
    [projectActionProjectId, projects],
  )

  useEffect(() => {
    if (!selectedId && activeProjects.length > 0) setSelectedId(activeProjects[0].id)
  }, [activeProjects, selectedId])

  useEffect(() => {
    if (pendingSelectedId) {
      if (activeProjects.some((p) => p.id === pendingSelectedId)) {
        setSelectedId(pendingSelectedId)
        setPendingSelectedId(null)
      }
      return
    }
    if (selectedId && !activeProjects.some((p) => p.id === selectedId)) {
      setSelectedId(activeProjects[0]?.id ?? '')
      setDirty(false)
    }
  }, [activeProjects, pendingSelectedId, selectedId])

  useEffect(() => {
    if (selected && !dirty) {
      setForm({
        copyFiles: parseCopyFiles(selected.copyFiles),
        setupScript: selected.setupScript ?? '',
        quickCommands: parseQuickCommands(selected.quickCommands),
      })
    }
  }, [selected, dirty])

  if (isLoading) {
    return (
      <SettingsPageContainer className="max-w-5xl">
        <div className="flex items-center justify-center py-20">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-600" />
        </div>
      </SettingsPageContainer>
    )
  }

  if (projects.length === 0) {
    return (
      <SettingsPageContainer className="max-w-5xl">
        <h2 className="text-base font-semibold text-neutral-900 mb-5">{t('项目配置')}</h2>
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 py-16 text-center">
          <p className="text-sm text-neutral-400">{t('暂无项目，请先创建项目')}</p>
        </div>
      </SettingsPageContainer>
    )
  }

  const handleSave = () => {
    if (!selectedId) return
    updateProject.mutate(
      {
        id: selectedId,
        copyFiles: form.copyFiles.length > 0 ? form.copyFiles.join(', ') : null,
        setupScript: form.setupScript.trim() || null,
        quickCommands: form.quickCommands.length > 0 ? JSON.stringify(form.quickCommands) : null,
      },
      { onSuccess: () => setDirty(false) },
    )
  }

  const handleProjectChange = (id: string) => {
    setPendingSelectedId(null)
    setSelectedId(id)
    setDirty(false)
  }

  const handleOpenArchiveProject = () => {
    if (!selected) return
    setProjectActionProjectId(selected.id)
    setDeleteProjectWithRepo(false)
    setConfirmDeleteProjectRepo(false)
    setIsArchiveProjectOpen(true)
  }

  const handleCloseArchiveProject = () => {
    if (archiveProject.isPending) return
    setIsArchiveProjectOpen(false)
    setProjectActionProjectId(null)
    setDeleteProjectWithRepo(false)
    setConfirmDeleteProjectRepo(false)
  }

  const handleSubmitArchiveProject = async () => {
    if (!projectActionProjectId) return
    try {
      await archiveProject.mutateAsync({ id: projectActionProjectId, deleteRepo: deleteProjectWithRepo })
      toast.success(deleteProjectWithRepo ? t('项目已删除，并清理了本地文件') : t('项目已删除'))
      setDirty(false)
      handleCloseArchiveProject()
    } catch { /* mutation error managed by TanStack Query */ }
  }

  const handleOpenRestoreProject = (projectId: string) => {
    const project = archivedProjects.find((item) => item.id === projectId)
    setProjectActionProjectId(projectId)
    setRestoreProjectRepoPath(project?.repoDeletedAt ? project.repoPath : '')
    setIsRestoreProjectOpen(true)
  }

  const handleCloseRestoreProject = () => {
    if (restoreProject.isPending) return
    setIsRestoreProjectOpen(false)
    setProjectActionProjectId(null)
    setRestoreProjectRepoPath('')
  }

  const handleSubmitRestoreProject = async () => {
    if (!projectActionProjectId) return
    const requiresRepoPath = Boolean(selectedProjectForAction?.repoDeletedAt)
    if (requiresRepoPath && !restoreProjectRepoPath.trim()) return

    try {
      const result = await restoreProject.mutateAsync({
        id: projectActionProjectId,
        repoPath: restoreProjectRepoPath.trim() || undefined,
      })
      toast.success(t('项目已恢复'))
      for (const warning of result.warnings) toast.warning(warning)
      setDirty(false)
      setPendingSelectedId(result.project.id)
      setSelectedId(result.project.id)
      handleCloseRestoreProject()
    } catch { /* mutation error managed by TanStack Query */ }
  }

  const archiveProjectName = selectedProjectForAction?.name ?? t('this project')
  const restoreRequiresRepoPath = Boolean(selectedProjectForAction?.repoDeletedAt)

  return (
    <>
      <SettingsPageContainer className="max-w-5xl">
        <h2 className="text-base font-semibold text-neutral-900 mb-5">{t('项目配置')}</h2>

        {activeProjects.length === 0 && archivedProjects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 py-16 text-center">
            <p className="text-sm text-neutral-400">{t('暂无项目，请先创建项目')}</p>
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:h-[calc(100vh-16rem)] lg:max-h-[640px]">
            {/* Project list sidebar — independent scroll */}
            <div className={cn('space-y-1 lg:overflow-y-auto lg:pr-1 scrollbar-app-thin', mobileShowDetail && 'hidden lg:block')}>
              {activeProjects.map((project) => {
                const isActive = project.id === selectedId
                return (
                  <button
                    key={project.id}
                    onClick={() => {
                      handleProjectChange(project.id)
                      setMobileShowDetail(true)
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                      isActive
                        ? 'bg-neutral-900 text-white'
                        : 'hover:bg-neutral-50 text-neutral-700',
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full shrink-0', isActive ? 'bg-white/60' : getProjectDotClass(project))} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{project.name}</div>
                      <div className={cn('truncate text-[11px] font-mono', isActive ? 'text-neutral-300' : 'text-neutral-400')}>
                        {project.repoPath.split('/').pop()}
                      </div>
                    </div>
                  </button>
                )
              })}

              {/* Archived section in sidebar */}
              {archivedProjects.length > 0 && (
                <div className="pt-3 mt-2 border-t border-neutral-100">
                  <div className="flex items-center gap-2 px-3 mb-1">
                    <span className="text-[11px] font-medium text-neutral-400">{t('已删除')}</span>
                    <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                      {archivedProjects.length}
                    </span>
                  </div>
                  {archivedProjects.map((project) => (
                    <div key={project.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-neutral-500">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] text-neutral-500">{project.name}</div>
                      </div>
                      <button
                        onClick={() => handleOpenRestoreProject(project.id)}
                        disabled={restoreProject.isPending}
                        className="shrink-0 text-[11px] text-neutral-400 hover:text-neutral-900 transition-colors"
                      >
                        <RotateCcw size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Detail panel — independent scroll */}
            <div className={cn(
              'rounded-xl border border-neutral-200 bg-white lg:overflow-y-auto scrollbar-app-thin',
              !mobileShowDetail && 'hidden lg:block',
            )}>
              {/* Mobile back button */}
              <button
                onClick={() => setMobileShowDetail(false)}
                className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors px-5 pt-3 lg:hidden"
              >
                <ArrowLeft size={14} />
                {t('返回列表')}
              </button>

              {selected ? (
                <div className="p-5">
                  {/* Project info header */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', getProjectDotClass(selected))} />
                    <h3 className="text-base font-semibold text-neutral-900">{selected.name}</h3>
                  </div>
                  <p className="text-[11px] text-neutral-400 font-mono mb-5">{selected.repoPath}</p>

                  {/* Config sections */}
                  <div className="divide-y divide-neutral-100">
                    {/* Copy Files */}
                    <div className="py-5 first:pt-0">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-neutral-900">{t('自动复制文件')}</h3>
                        <p className="text-[11px] text-neutral-400 mt-0.5">
                          {t('创建 worktree 时自动从主仓库复制的文件或目录，适用于 .env、node_modules 等不在 git 管理中的文件。支持 glob。')}
                        </p>
                      </div>
                      <FilePathListInput
                        value={form.copyFiles}
                        onChange={(paths) => { setForm((prev) => ({ ...prev, copyFiles: paths })); setDirty(true) }}
                        repoPath={selected.repoPath}
                      />
                    </div>

                    {/* Setup Script */}
                    <div className="py-5">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-neutral-900">{t('Setup 脚本')}</h3>
                        <p className="text-[11px] text-neutral-400 mt-0.5">
                          {t('创建 worktree 后自动执行的命令，每行一条。在 worktree 目录下执行，单条超时 5 分钟。')}
                        </p>
                      </div>
                      <textarea
                        value={form.setupScript}
                        onChange={(e) => { setForm((prev) => ({ ...prev, setupScript: e.target.value })); setDirty(true) }}
                        placeholder={"pnpm install\npnpm run setup"}
                        rows={4}
                        className="w-full rounded-lg border border-neutral-200 bg-neutral-50/50 px-3 py-2 text-sm font-mono transition-colors focus:border-neutral-400 focus:bg-white focus:outline-none resize-none"
                      />
                    </div>

                    {/* Quick Commands */}
                    <div className="py-5">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-neutral-900">{t('常用命令')}</h3>
                        <p className="text-[11px] text-neutral-400 mt-0.5">
                          {t('在终端中可快速执行的命令，不会自动运行。')}
                        </p>
                      </div>
                      <QuickCommandsEditor
                        value={form.quickCommands}
                        onChange={(cmds) => { setForm((prev) => ({ ...prev, quickCommands: cmds })); setDirty(true) }}
                      />
                    </div>
                  </div>

                  {/* Danger zone */}
                  <div className="mt-2 rounded-lg border border-red-200/60 bg-red-50/30 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
                        <div>
                          <div className="text-[13px] font-medium text-red-900">{t('删除项目')}</div>
                          <p className="text-[11px] text-red-600/70 mt-0.5">
                            {t('项目将从默认列表隐藏，历史记录保留。可选同时删除本地文件。')}
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="shrink-0"
                        onClick={handleOpenArchiveProject}
                        disabled={archiveProject.isPending || restoreProject.isPending}
                      >
                        <Trash2 size={13} />
                        {t('删除项目')}
                      </Button>
                    </div>
                  </div>

                  {/* Sticky save bar */}
                  {dirty && (
                    <div className="sticky bottom-0 -mx-5 px-5 py-3 mt-4 bg-white/90 backdrop-blur border-t border-neutral-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-neutral-500">{t('有未保存的更改')}</span>
                        <Button size="sm" onClick={handleSave} disabled={updateProject.isPending}>
                          {updateProject.isPending ? t('保存中...') : t('保存')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-neutral-400">
                  {activeProjects.length > 0 ? t('选择一个项目查看配置') : t('当前没有可配置的项目')}
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsPageContainer>

      {/* Archive/Delete Modal */}
      <Modal
        isOpen={isArchiveProjectOpen}
        onClose={handleCloseArchiveProject}
        title={t('Delete Project')}
        action={
          <>
            <Button variant="outline" onClick={handleCloseArchiveProject} disabled={archiveProject.isPending}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleSubmitArchiveProject}
              disabled={archiveProject.isPending || (deleteProjectWithRepo && !confirmDeleteProjectRepo)}
            >
              {archiveProject.isPending ? t('Deleting...') : t('Delete Project')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-600 leading-relaxed">
            {t('项目「{title}」将从默认项目列表隐藏，但历史任务、workspace 和会话记录仍会保留。', {
              title: archiveProjectName,
            })}
          </p>
          <label className="flex items-start gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3">
            <input
              type="checkbox"
              checked={deleteProjectWithRepo}
              onChange={(e) => {
                setDeleteProjectWithRepo(e.target.checked)
                if (!e.target.checked) setConfirmDeleteProjectRepo(false)
              }}
              className="mt-0.5"
            />
            <div>
              <p className="text-sm font-medium text-neutral-900">{t('同时删除本地项目文件')}</p>
              <p className="mt-1 text-xs text-neutral-500">
                {t('勾选后会删除 repoPath 指向的本地仓库目录，并禁用代码/Git 相关能力。')}
              </p>
            </div>
          </label>
          {deleteProjectWithRepo && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3">
              <p className="text-sm font-medium text-red-700">
                {t('勾选后会连项目文件一起删除，请谨慎选择。')}
              </p>
              <p className="mt-1 text-xs text-red-600">
                {t('恢复该项目时需要重新绑定一个有效的 Git 仓库路径。')}
              </p>
              <label className="mt-3 flex items-start gap-2 text-xs text-red-700">
                <input
                  type="checkbox"
                  checked={confirmDeleteProjectRepo}
                  onChange={(e) => setConfirmDeleteProjectRepo(e.target.checked)}
                  className="mt-0.5"
                />
                <span>{t('我已确认这会删除本地项目文件')}</span>
              </label>
            </div>
          )}
          {archiveProject.isError && (
            <p className="text-xs text-red-500">
              {archiveProject.error instanceof Error ? archiveProject.error.message : t('Failed to delete project')}
            </p>
          )}
        </div>
      </Modal>

      {/* Restore Modal */}
      <Modal
        isOpen={isRestoreProjectOpen}
        onClose={handleCloseRestoreProject}
        title={t('Restore Project')}
        action={
          <>
            <Button variant="outline" onClick={handleCloseRestoreProject} disabled={restoreProject.isPending}>
              {t('Cancel')}
            </Button>
            <Button
              onClick={handleSubmitRestoreProject}
              disabled={restoreProject.isPending || (restoreRequiresRepoPath && !restoreProjectRepoPath.trim())}
            >
              {restoreProject.isPending ? t('Restoring...') : t('Restore Project')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-600 leading-relaxed">
            {restoreRequiresRepoPath
              ? t('项目「{title}」的本地仓库文件已删除。恢复前需要重新绑定一个有效的 Git 仓库路径。', {
                  title: archiveProjectName,
                })
              : t('恢复后，项目会重新出现在默认项目列表中。')}
          </p>
          {restoreRequiresRepoPath && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('Repository Path')}
              </label>
              <FolderPicker value={restoreProjectRepoPath} onChange={setRestoreProjectRepoPath} />
              <p className="mt-2 text-xs text-neutral-400">
                {t('Agent Tower 会尽量校验仓库 identity；如果 remote URL 或目录名不同，会给出警告但允许继续。')}
              </p>
            </div>
          )}
          {restoreProject.isError && (
            <p className="text-xs text-red-500">
              {restoreProject.error instanceof Error ? restoreProject.error.message : t('Failed to restore project')}
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
