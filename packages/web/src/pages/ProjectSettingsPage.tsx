import { useState, useEffect, useMemo } from 'react'
import { RotateCcw, Trash2, AlertTriangle } from 'lucide-react'
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
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsMasterDetailSkeleton,
  SettingsEmptyState,
  SettingsSaveBar,
} from '@/components/settings/SettingsSection'
import { SettingsMasterDetail } from '@/components/settings/SettingsMasterDetail'

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
  if (typeof project.color !== 'string' || project.color.trim() === '') return 'bg-muted-foreground'
  if (project.color.startsWith('bg-')) return project.color
  if (project.color.startsWith('text-')) return project.color.replace('text-', 'bg-')
  return 'bg-muted-foreground'
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
        <SettingsMasterDetailSkeleton />
      </SettingsPageContainer>
    )
  }

  if (projects.length === 0) {
    return (
      <SettingsPageContainer className="max-w-5xl">
        <SettingsPageHeader title={t('项目配置')} />
        <SettingsEmptyState message={t('暂无项目，请先创建项目')} />
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
    setMobileShowDetail(true)
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
        <SettingsPageHeader title={t('项目配置')} />

        {activeProjects.length === 0 && archivedProjects.length === 0 ? (
          <SettingsEmptyState message={t('暂无项目，请先创建项目')} />
        ) : (
          <SettingsMasterDetail
            items={activeProjects}
            selectedId={selectedId}
            onSelectItem={handleProjectChange}
            getItemId={(p) => p.id}
            mobileShowDetail={mobileShowDetail}
            onMobileBack={() => setMobileShowDetail(false)}
            renderListItem={(project, isActive) => (
              <>
                <span
                  className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    isActive ? 'bg-primary-foreground/60' : getProjectDotClass(project),
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{project.name}</div>
                  <div
                    className={cn(
                      'truncate text-[11px] font-mono',
                      isActive ? 'text-primary-foreground/70' : 'text-muted-foreground',
                    )}
                  >
                    {project.repoPath.split('/').pop()}
                  </div>
                </div>
              </>
            )}
            renderListFooter={
              archivedProjects.length > 0
                ? () => (
                    <div className="pt-3 mt-2 border-t border-border">
                      <div className="flex items-center gap-2 px-3 mb-1">
                        <span className="text-[11px] font-medium text-muted-foreground">{t('已删除')}</span>
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {archivedProjects.length}
                        </span>
                      </div>
                      {archivedProjects.map((project) => (
                        <div
                          key={project.id}
                          className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-muted-foreground"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px]">{project.name}</div>
                          </div>
                          <button
                            onClick={() => handleOpenRestoreProject(project.id)}
                            disabled={restoreProject.isPending}
                            className="shrink-0 text-[11px] hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                            aria-label={t('恢复项目')}
                          >
                            <RotateCcw size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                : undefined
            }
            renderDetail={(project) =>
              project ? (
                <div className="p-5">
                  {/* Project info header */}
                  <div className="flex items-center gap-2 mb-1">
                    <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', getProjectDotClass(project))} />
                    <h3 className="text-base font-semibold text-foreground">{project.name}</h3>
                  </div>
                  <p className="text-[11px] text-muted-foreground font-mono mb-5">{project.repoPath}</p>

                  {/* Config sections */}
                  <div className="divide-y divide-border/60">
                    {/* Copy Files */}
                    <div className="py-5 first:pt-0">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-foreground">{t('自动复制文件')}</h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t(
                            '创建 worktree 时自动从主仓库复制的文件或目录，适用于 .env、node_modules 等不在 git 管理中的文件。支持 glob。',
                          )}
                        </p>
                      </div>
                      <FilePathListInput
                        value={form.copyFiles}
                        onChange={(paths) => {
                          setForm((prev) => ({ ...prev, copyFiles: paths }))
                          setDirty(true)
                        }}
                        repoPath={project.repoPath}
                      />
                    </div>

                    {/* Setup Script */}
                    <div className="py-5">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-foreground">{t('Setup 脚本')}</h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t('创建 worktree 后自动执行的命令，每行一条。在 worktree 目录下执行，单条超时 5 分钟。')}
                        </p>
                      </div>
                      <textarea
                        value={form.setupScript}
                        onChange={(e) => {
                          setForm((prev) => ({ ...prev, setupScript: e.target.value }))
                          setDirty(true)
                        }}
                        placeholder={'pnpm install\npnpm run setup'}
                        rows={4}
                        className="w-full rounded-lg border border-input bg-muted/50 px-3 py-2 text-sm font-mono transition-colors focus:border-ring focus:bg-background focus:outline-none resize-none"
                      />
                    </div>

                    {/* Quick Commands */}
                    <div className="py-5">
                      <div className="mb-3">
                        <h3 className="text-[13px] font-medium text-foreground">{t('常用命令')}</h3>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t('在终端中可快速执行的命令，不会自动运行。')}
                        </p>
                      </div>
                      <QuickCommandsEditor
                        value={form.quickCommands}
                        onChange={(cmds) => {
                          setForm((prev) => ({ ...prev, quickCommands: cmds }))
                          setDirty(true)
                        }}
                      />
                    </div>
                  </div>

                  {/* Danger zone */}
                  <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={15} className="text-destructive mt-0.5 shrink-0" aria-hidden="true" />
                        <div>
                          <div className="text-[13px] font-medium text-foreground">{t('删除项目')}</div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
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

                  {/* Save bar */}
                  {dirty && (
                    <SettingsSaveBar
                      saving={updateProject.isPending}
                      onSave={handleSave}
                      onCancel={() => {
                        if (selected) {
                          setForm({
                            copyFiles: parseCopyFiles(selected.copyFiles),
                            setupScript: selected.setupScript ?? '',
                            quickCommands: parseQuickCommands(selected.quickCommands),
                          })
                        }
                        setDirty(false)
                      }}
                      className="-mx-5"
                    />
                  )}
                </div>
              ) : (
                <div className="py-16 text-center text-sm text-muted-foreground">
                  {activeProjects.length > 0 ? t('选择一个项目查看配置') : t('当前没有可配置的项目')}
                </div>
              )
            }
          />
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
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('项目「{title}」将从默认项目列表隐藏，但历史任务、workspace 和会话记录仍会保留。', {
              title: archiveProjectName,
            })}
          </p>
          <label className="flex items-start gap-3 rounded-lg border border-border bg-muted px-3 py-3">
            <input
              type="checkbox"
              checked={deleteProjectWithRepo}
              onChange={(e) => {
                setDeleteProjectWithRepo(e.target.checked)
                if (!e.target.checked) setConfirmDeleteProjectRepo(false)
              }}
              className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
            />
            <div>
              <p className="text-sm font-medium text-foreground">{t('同时删除本地项目文件')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('勾选后会删除 repoPath 指向的本地仓库目录，并禁用代码/Git 相关能力。')}
              </p>
            </div>
          </label>
          {deleteProjectWithRepo && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3">
              <p className="text-sm font-medium text-destructive">
                {t('勾选后会连项目文件一起删除，请谨慎选择。')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('恢复该项目时需要重新绑定一个有效的 Git 仓库路径。')}
              </p>
              <label className="mt-3 flex items-start gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={confirmDeleteProjectRepo}
                  onChange={(e) => setConfirmDeleteProjectRepo(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
                />
                <span>{t('我已确认这会删除本地项目文件')}</span>
              </label>
            </div>
          )}
          {archiveProject.isError && (
            <p className="text-xs text-destructive">
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
          <p className="text-sm text-muted-foreground leading-relaxed">
            {restoreRequiresRepoPath
              ? t('项目「{title}」的本地仓库文件已删除。恢复前需要重新绑定一个有效的 Git 仓库路径。', {
                  title: archiveProjectName,
                })
              : t('恢复后，项目会重新出现在默认项目列表中。')}
          </p>
          {restoreRequiresRepoPath && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">{t('Repository Path')}</label>
              <FolderPicker value={restoreProjectRepoPath} onChange={setRestoreProjectRepoPath} />
              <p className="mt-2 text-xs text-muted-foreground">
                {t('Agent Tower 会尽量校验仓库 identity；如果 remote URL 或目录名不同，会给出警告但允许继续。')}
              </p>
            </div>
          )}
          {restoreProject.isError && (
            <p className="text-xs text-destructive">
              {restoreProject.error instanceof Error ? restoreProject.error.message : t('Failed to restore project')}
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
