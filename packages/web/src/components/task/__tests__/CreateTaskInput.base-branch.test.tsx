// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, WorkspaceKind } from '@agent-tower/shared'
import { CreateTaskInput, type CreateTaskInputProps } from '../CreateTaskInput'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useProjectWorkspaceBranches: (id: string) => ({
  data: { mainBranch: id === 'b' ? 'release' : 'main', branches: ['main', 'develop', 'release'], workspaces: [] },
  isPending: false, isFetching: false, isError: false, refetch: vi.fn(),
}) }))
vi.mock('@/hooks/use-attachments', () => ({ useAttachments: () => ({ files: [], addFiles: vi.fn(), removeFile: vi.fn(), buildMarkdownLinks: () => '', getDoneAttachments: () => [], isUploading: false }) }))
vi.mock('@/hooks/use-projects', () => ({ useRefreshProjectGitCapability: () => ({ mutateAsync: vi.fn(), isPending: false }) }))
vi.mock('@/hooks/use-slash-command-catalog', () => ({ useSlashCommandCatalog: () => ({ data: [] }), mergeSlashCommandCatalog: (commands: unknown[]) => commands }))
vi.mock('@/components/team/TeamRunCreateForm', () => ({ TeamRunCreateForm: ({ setSelectedTemplateId }: { setSelectedTemplateId: (id: string) => void }) => <button onClick={() => setSelectedTemplateId('template')}>Choose template</button> }))

let root: Root
let container: HTMLDivElement
function render(overrides: Partial<CreateTaskInputProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onSubmit = vi.fn(async () => undefined)
  const props: CreateTaskInputProps = {
    projects: [{ id: 'a', name: 'Alpha', mainBranch: 'main' }, { id: 'b', name: 'Beta', mainBranch: 'release' }],
    providers: [{ id: 'provider', name: 'Codex', agentType: AgentType.CODEX, available: true }],
    defaultProjectId: 'a', defaultProviderId: 'provider', createStep: 'idle', onSubmit, ...overrides,
  }
  act(() => root.render(<CreateTaskInput {...props} />))
  return { onSubmit, rerender: (change: Partial<CreateTaskInputProps>) => act(() => root.render(<CreateTaskInput {...props} {...change} />)) }
}
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => { (element as HTMLElement).click() })
  // Radix restores focus after a closing popover unmounts on the next task.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
function button(label: string) {
  return document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
}
function textButton(text: string) {
  return Array.from(document.body.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
}
async function chooseBranch(value: string) {
  await click(button('Base branch'))
  await click(Array.from(document.body.querySelectorAll('[role="option"]')).find(item => item.textContent === value))
}
async function submit() {
  const textarea = container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Implement task')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(container.querySelector('button[title="Create & Start"]'))
}
afterEach(() => { act(() => root?.unmount()); container?.remove() })

describe('task creation base branch', () => {
  it('defaults a subtask to its parent branch and submits the relationship', async () => {
    const { onSubmit } = render({ parentTask: { id: 'parent', title: 'Parent task', projectId: 'a', baseBranch: 'at/parent' } })
    expect(button('Base branch')!.textContent).toBe('at/parent')
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ parentTaskId: 'parent', baseBranch: 'at/parent', projectId: 'a' }))
  })

  it('defaults to the project base, saves an override and resets after submission', async () => {
    const { onSubmit } = render()
    expect(button('Base branch')!.textContent).toBe('main')
    await chooseBranch('develop')
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'develop', workspaceMode: WorkspaceKind.WORKTREE }))
    expect(button('Base branch')!.textContent).toBe('main')
  })

  it('resets the branch when choosing another project or changing the default project', async () => {
    const { rerender } = render()
    await chooseBranch('develop')
    await click(button('Project'))
    await click(textButton('Beta'))
    expect(button('Base branch')!.textContent).toBe('release')
    rerender({ defaultProjectId: 'b' })
    await chooseBranch('develop')
    rerender({ defaultProjectId: 'a' })
    expect(button('Base branch')!.textContent).toBe('main')
  })

  it('submits a TeamRun with the selected base and keeps its switch outside the overflow area', async () => {
    const { onSubmit } = render()
    await chooseBranch('develop')
    await click(textButton('Team mode'))
    expect(container.querySelector('[data-task-mode-switch]')).toBeTruthy()
    expect(container.querySelector('[data-task-options]')!.contains(textButton('Team mode')!)).toBe(false)
    await click(textButton('Choose template'))
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'develop', mode: 'TEAM', teamTemplateId: 'template' }))
  })

  it('omits branch selection in main-directory mode', async () => {
    const { onSubmit } = render()
    await chooseBranch('develop')
    await click(button('Workspace mode'))
    await click(Array.from(document.body.querySelectorAll('button')).find(item => item.textContent?.includes('本地模式')))
    expect(button('Base branch')).toBeNull()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: null, workspaceMode: WorkspaceKind.MAIN_DIRECTORY }))
  })

  it('retains the branch after a rejected creation', async () => {
    render({ onSubmit: vi.fn(async () => { throw new Error('Failed') }) })
    await chooseBranch('develop')
    await submit()
    expect(button('Base branch')!.textContent).toBe('develop')
    expect(container.querySelector('textarea')!.value).toBe('Implement task')
  })

  it('hides branch selection and disables team mode for a non-Git project', () => {
    render({ projects: [{ id: 'a', name: 'Local', isGitRepo: false, worktreeReady: false }] })
    expect(button('Base branch')).toBeNull()
    expect(textButton('Team mode')!.disabled).toBe(true)
  })
})
