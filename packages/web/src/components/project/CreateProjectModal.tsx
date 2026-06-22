import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useCreateProject } from '@/hooks/use-projects'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { FolderPicker } from '@/components/ui/folder-picker'
import { Modal } from '@/components/ui/modal'

interface CreateProjectModalProps {
  isOpen: boolean
  onClose: () => void
}

interface ValidateResponse {
  valid: boolean
  path: string
  reason?: 'not_found' | 'not_directory' | 'no_git' | 'permission_denied' | string
  isGitRepo?: boolean
  isEmpty?: boolean
  error?: string
}

export function CreateProjectModal({ isOpen, onClose }: CreateProjectModalProps) {
  const { t } = useI18n()
  const createProject = useCreateProject()
  const [projectName, setProjectName] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [showInitConfirm, setShowInitConfirm] = useState(false)

  const trimmedName = projectName.trim()
  const trimmedRepoPath = repoPath.trim()
  const isBusy = isChecking || createProject.isPending

  const canSubmit = useMemo(
    () => Boolean(trimmedName && trimmedRepoPath && !isBusy),
    [trimmedName, trimmedRepoPath, isBusy],
  )

  const resetForm = useCallback(() => {
    setProjectName('')
    setRepoPath('')
    setFormError(null)
    setShowInitConfirm(false)
  }, [])

  const closeModal = useCallback(() => {
    if (isBusy) return
    resetForm()
    onClose()
  }, [isBusy, onClose, resetForm])

  useEffect(() => {
    if (!isOpen) {
      resetForm()
    }
  }, [isOpen, resetForm])

  const createWithCurrentValues = useCallback(async (initEmptyRepo: boolean) => {
    try {
      await createProject.mutateAsync({
        name: trimmedName,
        repoPath: trimmedRepoPath,
        initEmptyRepo,
      })
      resetForm()
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Failed to create project')
      setFormError(message)
      toast.error(message)
    }
  }, [createProject, onClose, resetForm, t, trimmedName, trimmedRepoPath])

  const handleSubmit = useCallback(async () => {
    if (!trimmedName || !trimmedRepoPath || isBusy) return

    setFormError(null)
    setIsChecking(true)
    try {
      const validation = await apiClient.get<ValidateResponse>('/filesystem/validate', {
        params: { path: trimmedRepoPath },
      })

      if (!validation.valid) {
        setFormError(validation.error ?? t('Selected path is not a valid directory'))
        return
      }

      if (validation.isGitRepo) {
        await createWithCurrentValues(false)
        return
      }

      if (validation.reason === 'no_git' && validation.isEmpty) {
        setShowInitConfirm(true)
        return
      }

      if (validation.reason === 'no_git') {
        await createWithCurrentValues(false)
        return
      }

      await createWithCurrentValues(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('Could not check project path'))
    } finally {
      setIsChecking(false)
    }
  }, [createWithCurrentValues, isBusy, t, trimmedName, trimmedRepoPath])

  const handleCreateLocalProject = useCallback(() => {
    setShowInitConfirm(false)
    void createWithCurrentValues(false)
  }, [createWithCurrentValues])

  const handleConfirmInit = useCallback(() => {
    setShowInitConfirm(false)
    void createWithCurrentValues(true)
  }, [createWithCurrentValues])

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={closeModal}
        title={t('Create New Project')}
        action={
          <>
            <button
              onClick={closeModal}
              disabled={isBusy}
              className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors disabled:opacity-50"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                canSubmit
                  ? 'bg-neutral-900 text-white hover:bg-black'
                  : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
              }`}
            >
              {isChecking ? t('Checking...') : createProject.isPending ? t('Creating...') : t('Create Project')}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              {t('Project Name')}
            </label>
            <input
              type="text"
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder={t('e.g., Agent Tower')}
              disabled={isBusy}
              className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors disabled:bg-neutral-50 disabled:text-neutral-400"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              {t('Project Path')}
            </label>
            <FolderPicker
              value={repoPath}
              onChange={setRepoPath}
              validationMode="directory"
            />
          </div>
          {formError && (
            <p className="text-xs text-red-500 leading-relaxed">
              {formError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={showInitConfirm}
        onClose={() => {
          if (!createProject.isPending) {
            setShowInitConfirm(false)
          }
        }}
        title={t('Initialize Git repository?')}
        action={
          <>
            <button
              onClick={() => setShowInitConfirm(false)}
              disabled={createProject.isPending}
              className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors disabled:opacity-50"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleCreateLocalProject}
              disabled={createProject.isPending}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-neutral-200 text-neutral-700 hover:bg-neutral-50 transition-colors disabled:opacity-50"
            >
              {t('Create Local Project')}
            </button>
            <button
              onClick={handleConfirmInit}
              disabled={createProject.isPending}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-neutral-900 text-white hover:bg-black transition-colors disabled:opacity-50"
            >
              {createProject.isPending ? t('Creating...') : t('Initialize and Create')}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-neutral-600 leading-relaxed">
          <p>
            {t('This directory is empty and does not have Git version control yet. Agent Tower can initialize Git and create the initial commit before creating the project.')}
          </p>
          <p>
            {t('You can also create it as a local project now. Local projects only support local Solo tasks until Git is initialized.')}
          </p>
        </div>
      </Modal>
    </>
  )
}
