import { useState, useEffect } from 'react'
import { useProjects, useUpdateProject } from '@/hooks/use-projects'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { FilePathListInput } from '@/components/ui/file-path-list-input'
import { QuickCommandsEditor } from '@/components/ui/quick-commands-editor'
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

export function ProjectSettingsPage() {
  const { t } = useI18n()
  const { data: projectsData, isLoading } = useProjects({ limit: 100 })
  const updateProject = useUpdateProject()

  const [selectedId, setSelectedId] = useState<string>('')
  const [form, setForm] = useState<FormState>({ copyFiles: [], setupScript: '', quickCommands: [] })
  const [dirty, setDirty] = useState(false)

  const projects: Project[] = projectsData?.data ?? []
  const selected = projects.find((p) => p.id === selectedId)

  useEffect(() => {
    if (!selectedId && projects.length > 0) {
      setSelectedId(projects[0].id)
    }
  }, [projects, selectedId])

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

  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }))

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
    setSelectedId(id)
    setDirty(false)
  }

  return (
    <div className="px-10 py-6 mx-auto w-full max-w-3xl space-y-8">
      {/* 项目选择 */}
      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('选择项目')}</h3>
        <Select
          value={selectedId}
          onChange={handleProjectChange}
          options={projectOptions}
          placeholder={t('选择项目...')}
        />
      </section>

      {/* 自动复制文件 */}
      <section>
        <h3 className="text-[13px] font-semibold text-neutral-900 mb-1">{t('自动复制文件')}</h3>
        <p className="text-[12px] text-neutral-400 mb-3">
          {t('创建 worktree 时自动从主仓库复制的文件或目录。支持 glob 模式。')}
        </p>
        <FilePathListInput
          value={form.copyFiles}
          onChange={(paths) => { setForm((prev) => ({ ...prev, copyFiles: paths })); setDirty(true) }}
          repoPath={selected?.repoPath ?? ''}
        />
        <p className="text-[11px] text-neutral-400 mt-2">
          {t('适用于不在 git 管理中但启动必需的文件，如 .env、node_modules、数据库文件等')}
        </p>
      </section>

      {/* Setup 脚本 */}
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

      {/* 常用命令 */}
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

      {/* 保存按钮 */}
      {dirty && (
        <div className="sticky bottom-6 flex justify-end">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateProject.isPending}
          >
            {updateProject.isPending ? t('保存中...') : t('保存')}
          </Button>
        </div>
      )}
    </div>
  )
}
