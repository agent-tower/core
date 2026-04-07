import { useState, useEffect, useMemo } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useProjects, useUpdateProject, useArchiveProject, useRestoreProject } from '@/hooks/use-projects'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { FilePathListInput } from '@/components/ui/file-path-list-input'
import { QuickCommandsEditor } from '@/components/ui/quick-commands-editor'
import { Modal } from '@/components/ui/modal'
import { FolderPicker } from '@/components/ui/folder-picker'
import type { Project, QuickCommand } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'

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
  if (typeof project.color !== 'string' || project.color.trim() === '') {
    return 'bg-neutral-400'
  }
  if (project.color.startsWith('bg-')) {
    return project.color
  }
  if (project.color.startsWith('text-')) {
    return project.color.replace('text-', 'bg-')
  }
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

  const projects: Project[] = projectsData?.data ?? []
  const activeProjects = useMemo(() => projects.filter((p) => !p.archivedAt), [projects])
  const archivedProjects = useMemo(() => projects.filter((p) => p.archivedAt), [projects])
  const selected = activeProjects.find((p) => p.id === selectedId)
  const selectedProjectForAction = useMemo(
    () => projects.find((p) => p.id === projectActionProjectId) ?? null,
    [projectActionProjectId, projects],
  )

  useEffect(() => {
    if (!selectedId && activeProjects.length > 0) {
      setSelectedId(activeProjects[0].id)
    }
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
    return <div className="p-6 text-sm text-neutral-400">{t('加载中...')}</div>
  }

  if (projects.length === 0) {
    return <div className="p-6 text-sm text-neutral-400">{t('暂无项目，请先创建项目')}</div>
  }

  const projectOptions = activeProjects.map((p) => ({ value: p.id, label: p.name }))

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
      await archiveProject.mutateAsync({
        id: projectActionProjectId,
        deleteRepo: deleteProjectWithRepo,
      })

      toast.success(deleteProjectWithRepo ? t('项目已删除，并清理了本地文件') : t('项目已删除'))
      setDirty(false)
      handleCloseArchiveProject()
    } catch {
      // mutation error 由 TanStack Query 管理
    }
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
      for (const warning of result.warnings) {
        toast.warning(warning)
      }

      setDirty(false)
      setPendingSelectedId(result.project.id)
      setSelectedId(result.project.id)
      handleCloseRestoreProject()
    } catch {
      // mutation error 由 TanStack Query 管理
    }
  }

  const archiveProjectName = selectedProjectForAction?.name ?? t('this project')
  const restoreRequiresRepoPath = Boolean(selectedProjectForAction?.repoDeletedAt)

  return (
    <>
      <div className="px-10 py-6 mx-auto w-full max-w-4xl space-y-8">
        <section className="space-y-3">
          <div>
            <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('项目配置')}</h3>
            <p className="text-[12px] text-neutral-400">
              {t('配置当前项目的 worktree 初始化行为，并在此页统一管理删除与恢复。')}
            </p>
          </div>

          {activeProjects.length > 0 ? (
            <>
              <div>
                <label className="block text-[12px] font-medium text-neutral-700 mb-2">{t('选择项目')}</label>
                <Select
                  value={selectedId}
                  onChange={handleProjectChange}
                  options={projectOptions}
                  placeholder={t('选择项目...')}
                />
              </div>

              {selected ? (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${getProjectDotClass(selected)}`} />
                        <p className="text-sm font-medium text-neutral-900">{selected.name}</p>
                      </div>
                      <p className="text-xs text-neutral-500 break-all">{selected.repoPath}</p>
                      {selected.repoRemoteUrl ? (
                        <p className="text-xs text-neutral-400 break-all">
                          {t('Remote')}: {selected.repoRemoteUrl}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col items-stretch gap-2 md:items-end">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleOpenArchiveProject}
                        disabled={archiveProject.isPending || restoreProject.isPending}
                      >
                        <Trash2 size={14} />
                        {t('删除项目')}
                      </Button>
                      <p className="text-[11px] text-neutral-500 md:max-w-56 md:text-right">
                        {t('删除后项目会从默认列表隐藏，但历史任务、workspace 与会话记录仍会保留。')}
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-5 text-sm text-neutral-500">
              {t('当前没有可配置的项目。你可以先创建项目，或在下方恢复已删除项目。')}
            </div>
          )}
        </section>

        {selected ? (
          <>
            <section>
              <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('自动复制文件')}</h3>
              <p className="text-[12px] text-neutral-400 mb-3">
                {t('创建 worktree 时自动从主仓库复制的文件或目录。支持 glob 模式。')}
              </p>
              <FilePathListInput
                value={form.copyFiles}
                onChange={(paths) => { setForm((prev) => ({ ...prev, copyFiles: paths })); setDirty(true) }}
                repoPath={selected.repoPath}
              />
              <p className="text-[11px] text-neutral-400 mt-2">
                {t('适用于不在 git 管理中但启动必需的文件，如 .env、node_modules、数据库文件等')}
              </p>
            </section>

            <section>
              <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('Setup 脚本')}</h3>
              <p className="text-[12px] text-neutral-400 mb-3">
                {t('创建 worktree 后自动执行的命令，每行一条，按顺序执行。')}
              </p>
              <textarea
                value={form.setupScript}
                onChange={(e) => { setForm((prev) => ({ ...prev, setupScript: e.target.value })); setDirty(true) }}
                placeholder={"pnpm install\npnpm run setup"}
                rows={4}
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-1 focus:ring-neutral-300 resize-none"
              />
              <p className="text-[11px] text-neutral-400 mt-1">
                {t('命令在 worktree 目录下执行，单条命令超时 5 分钟，失败不会阻断后续命令')}
              </p>
            </section>

            <section>
              <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('常用命令')}</h3>
              <p className="text-[12px] text-neutral-400 mb-3">
                {t('在终端中可快速执行的命令，不会自动运行。')}
              </p>
              <QuickCommandsEditor
                value={form.quickCommands}
                onChange={(cmds) => { setForm((prev) => ({ ...prev, quickCommands: cmds })); setDirty(true) }}
              />
            </section>
          </>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('已删除项目')}</h3>
              <p className="text-[12px] text-neutral-400">
                {t('这些项目不会出现在主看板里，但历史记录仍保留；如源码已删除，恢复时需要重新绑定 repoPath。')}
              </p>
            </div>
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-500">
              {archivedProjects.length}
            </span>
          </div>

          {archivedProjects.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-5 text-sm text-neutral-500">
              {t('暂无已删除项目')}
            </div>
          ) : (
            <div className="space-y-3">
              {archivedProjects.map((project) => (
                <div key={project.id} className="rounded-xl border border-neutral-200 bg-white px-4 py-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${getProjectDotClass(project)}`} />
                        <p className="text-sm font-medium text-neutral-900">{project.name}</p>
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
                          {t('已删除')}
                        </span>
                        {project.repoDeletedAt ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                            {t('源码已删除')}
                          </span>
                        ) : null}
                      </div>

                      {project.repoDeletedAt ? (
                        <p className="text-xs text-neutral-500">
                          {t('本地源码目录已删除，相关 Git/代码能力已禁用。恢复时需要重新绑定一个有效仓库路径。')}
                        </p>
                      ) : (
                        <p className="text-xs text-neutral-500 break-all">{project.repoPath}</p>
                      )}

                      {project.repoRemoteUrl ? (
                        <p className="text-xs text-neutral-400 break-all">
                          {t('Remote')}: {project.repoRemoteUrl}
                        </p>
                      ) : null}
                    </div>

                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenRestoreProject(project.id)}
                      disabled={archiveProject.isPending || restoreProject.isPending}
                    >
                      <RotateCcw size={14} />
                      {t('恢复')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {dirty && selected ? (
          <div className="sticky bottom-6 flex justify-end">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={updateProject.isPending}
            >
              {updateProject.isPending ? t('保存中...') : t('保存')}
            </Button>
          </div>
        ) : null}
      </div>

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

          {deleteProjectWithRepo ? (
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
          ) : null}

          {archiveProject.isError ? (
            <p className="text-xs text-red-500">
              {archiveProject.error instanceof Error ? archiveProject.error.message : t('Failed to delete project')}
            </p>
          ) : null}
        </div>
      </Modal>

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

          {restoreRequiresRepoPath ? (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                {t('Repository Path')}
              </label>
              <FolderPicker value={restoreProjectRepoPath} onChange={setRestoreProjectRepoPath} />
              <p className="mt-2 text-xs text-neutral-400">
                {t('Agent Tower 会尽量校验仓库 identity；如果 remote URL 或目录名不同，会给出警告但允许继续。')}
              </p>
            </div>
          ) : null}

          {restoreProject.isError ? (
            <p className="text-xs text-red-500">
              {restoreProject.error instanceof Error ? restoreProject.error.message : t('Failed to restore project')}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  )
}
