// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewStatus } from '@agent-tower/shared'
import { PreviewPanel } from '../PreviewPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { hookState, updateConfigMock } = vi.hoisted(() => ({
  hookState: {
    status: undefined as PreviewStatus | undefined,
    session: null,
  },
  updateConfigMock: vi.fn(),
}))

vi.mock('@/hooks/use-previews', () => ({
  usePreviewStatus: () => ({
    data: hookState.status,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(async () => ({ data: hookState.status })),
  }),
  useUpdatePreviewConfig: () => ({
    mutateAsync: updateConfigMock,
    isPending: false,
  }),
  usePreviewSession: () => ({
    session: hookState.session,
    isOpening: false,
    error: null,
    retry: vi.fn(),
  }),
}))

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

describe('PreviewPanel navigation requests', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    hookState.status = {
      configured: false,
      ready: false,
      target: null,
      viewUrl: null,
      error: null,
    }
    hookState.session = null
    updateConfigMock.mockReset()
    updateConfigMock.mockImplementation(async (target: string) => ({
      configured: true,
      ready: false,
      target,
      viewUrl: null,
      error: 'not running',
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('uses a clicked local URL as the workspace Preview target', async () => {
    await act(async () => {
      root.render(
        <PreviewPanel
          workspaceId="workspace-1"
          navigationRequest={{ id: 1, url: 'http://localhost:4173/dashboard?from=agent' }}
        />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(updateConfigMock).toHaveBeenCalledWith('http://localhost:4173')
  })
})
