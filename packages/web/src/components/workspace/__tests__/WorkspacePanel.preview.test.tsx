// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspacePanel, type WorkspacePanelHandle } from '../WorkspacePanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../PreviewPanel', async () => {
  const ReactModule = await import('react')
  return {
    PreviewPanel: ({ navigationRequest }: { navigationRequest?: { id: number; url: string } }) => ReactModule.createElement(
      'div',
      {
        'data-preview-request-id': navigationRequest?.id,
        'data-preview-url': navigationRequest?.url,
      },
      'Preview content',
    ),
  }
})

vi.mock('../EditorView', async () => {
  const ReactModule = await import('react')
  return {
    EditorView: ReactModule.forwardRef(() => ReactModule.createElement('div', null, 'Editor content')),
  }
})

vi.mock('../TerminalTabs', () => ({ TerminalTabs: () => null }))
vi.mock('../ReviewView', () => ({ ReviewView: () => null }))
vi.mock('../HistoryView', () => ({ HistoryView: () => null }))
vi.mock('@/hooks/use-projects', () => ({ useProject: () => ({ data: null }) }))
vi.mock('@/stores/git-visibility-store', () => ({
  useGitVisibilityStore: (selector: (state: { setVisibleContext: ReturnType<typeof vi.fn> }) => unknown) => selector({
    setVisibleContext: vi.fn(),
  }),
}))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))

describe('WorkspacePanel Preview navigation', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('expands the desktop rail and forwards an imperative URL to Preview', async () => {
    const tabRef = createRef<WorkspacePanelHandle>()
    const onExpandedChange = vi.fn()
    let expanded = false
    const render = async () => {
      await act(async () => {
        root.render(
          <WorkspacePanel
            workspaceId="workspace-1"
            workingDir="/tmp/workspace-1"
            projectId="project-1"
            gitAvailable={false}
            variant="rail"
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            tabRef={tabRef}
          />,
        )
      })
    }

    await render()
    await act(async () => {
      tabRef.current?.openPreview('http://localhost:4173/dashboard')
    })

    expect(onExpandedChange).toHaveBeenCalledWith(true)
    expanded = true
    await render()

    const preview = container.querySelector('[data-preview-url]')
    expect(preview?.getAttribute('data-preview-url')).toBe('http://localhost:4173/dashboard')
  })

  it('opens Preview from a declarative mobile request', async () => {
    await act(async () => {
      root.render(
        <WorkspacePanel
          workspaceId="workspace-1"
          workingDir="/tmp/workspace-1"
          projectId="project-1"
          gitAvailable={false}
          hideChanges
          previewRequest={{ id: 7, url: 'http://127.0.0.1:3000/login' }}
        />,
      )
    })

    const preview = container.querySelector('[data-preview-url]')
    expect(preview?.getAttribute('data-preview-request-id')).toBe('7')
    expect(preview?.getAttribute('data-preview-url')).toBe('http://127.0.0.1:3000/login')
  })
})
