// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, type SlashCommandOption } from '@agent-tower/shared'
import { CreateTaskInput, type CreateTaskInputProps } from '../CreateTaskInput'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const catalogRequests: Array<{ agentType?: string | null; workingDir?: string }> = []

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

vi.mock('@/hooks/use-attachments', () => ({
  useAttachments: () => ({
    files: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clear: vi.fn(),
    buildMarkdownLinks: () => '',
    getDoneAttachments: () => [],
    isUploading: false,
  }),
}))

vi.mock('@/hooks/use-projects', () => ({
  useRefreshProjectGitCapability: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@/hooks/use-slash-command-catalog', () => ({
  useSlashCommandCatalog: (request: { agentType?: string | null; workingDir?: string }) => {
    catalogRequests.push(request)
    return { data: [] }
  },
  mergeSlashCommandCatalog: (builtinCommands: SlashCommandOption[], discoveredCommands: SlashCommandOption[]) => [
    ...builtinCommands,
    ...discoveredCommands,
  ],
}))

vi.mock('@/components/team/TeamRunCreateForm', () => ({
  TeamRunCreateForm: () => null,
}))

vi.mock('@/components/agent', () => ({
  AgentLogo: () => null,
}))

vi.mock('../SlashCommandPopover', () => ({
  SlashCommandPopover: ({
    open,
    commands,
    onSelect,
  }: {
    open: boolean
    commands: SlashCommandOption[]
    onSelect: (command: SlashCommandOption) => void
  }) => open ? (
    <div data-testid="slash-command-menu">
      {commands.map((command) => (
        <button key={command.command} type="button" onClick={() => onSelect(command)}>
          {command.command}
        </button>
      ))}
    </div>
  ) : null,
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(props: Partial<CreateTaskInputProps> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const onSubmit = vi.fn(async () => undefined)

  act(() => {
    root!.render(
      <CreateTaskInput
        projects={[{
          id: 'project-1',
          name: 'Project 1',
          repoPath: '/repos/project-1',
        }]}
        providers={[{
          id: 'provider-1',
          name: 'Provider 1',
          agentType: AgentType.CODEX,
          available: true,
        }]}
        onSubmit={onSubmit}
        defaultProjectId="project-1"
        defaultProviderId="provider-1"
        createStep="idle"
        {...props}
      />,
    )
  })

  return { onSubmit }
}

async function setTextareaValue(value: string) {
  const textarea = container!.querySelector('textarea')!
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return textarea
}

async function pressEnter(textarea: HTMLTextAreaElement) {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
})

beforeEach(() => {
  catalogRequests.length = 0
})

describe('CreateTaskInput slash commands', () => {
  it('selects a slash command before submitting in task mode and uses the project directory', async () => {
    const { onSubmit } = render()
    const textarea = await setTextareaValue('/rev')

    expect(container!.querySelector('[data-testid="slash-command-menu"]')).toBeTruthy()
    await pressEnter(textarea)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('/review ')
    expect(catalogRequests.some((request) => (
      request.agentType === AgentType.CODEX && request.workingDir === '/repos/project-1'
    ))).toBe(true)

    await setTextareaValue('/review current changes')
    await pressEnter(textarea)

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: '/review current changes',
      projectId: 'project-1',
    }))
  })

  it('selects a slash command before starting conversation mode', async () => {
    const { onSubmit } = render({
      variant: 'conversation',
      projects: [],
      providers: [{
        id: 'provider-1',
        name: 'Provider 1',
        agentType: AgentType.CURSOR_AGENT,
        available: true,
      }],
    })
    const textarea = await setTextareaValue('/pla')

    expect(container!.querySelector('[data-testid="slash-command-menu"]')).toBeTruthy()
    await pressEnter(textarea)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('/plan ')
    expect(catalogRequests.some((request) => (
      request.agentType === AgentType.CURSOR_AGENT && request.workingDir === undefined
    ))).toBe(true)

    await setTextareaValue('/plan investigate the issue')
    await pressEnter(textarea)

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: '/plan investigate the issue',
      projectId: '',
    }))
  })
})
