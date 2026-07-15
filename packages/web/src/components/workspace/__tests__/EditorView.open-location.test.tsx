// @vitest-environment happy-dom
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView, type EditorViewHandle } from '../EditorView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { editorApi, fileData } = vi.hoisted(() => ({
  editorApi: {
    addCommand: vi.fn(),
    focus: vi.fn(),
    getModel: vi.fn(() => ({
      getLineCount: () => 100,
      getLineMaxColumn: () => 80,
    })),
    revealPositionInCenter: vi.fn(),
    setPosition: vi.fn(),
  },
  fileData: {
    content: Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'),
    language: 'typescript',
  },
}))

vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react')
  function MockEditor({ onMount }: { onMount?: (editor: typeof editorApi, monaco: unknown) => void }) {
    useEffect(() => {
      onMount?.(editorApi, {
        KeyCode: { KeyS: 49 },
        KeyMod: { CtrlCmd: 2048 },
      })
    }, [onMount])
    return null
  }

  return {
    default: MockEditor,
  }
})

vi.mock('@/lib/monaco', () => ({
  preloadMonaco: () => Promise.resolve(),
}))

vi.mock('@/hooks/use-files', () => ({
  useFileContent: (_workingDir?: string, path?: string | null) => ({
    data: path ? fileData : undefined,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useSaveFile: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}))

vi.mock('../FileTree', () => ({
  FileTree: () => null,
}))

vi.mock('react-zoom-pan-pinch', () => ({
  TransformWrapper: ({ children }: { children: React.ReactNode }) => children,
  TransformComponent: ({ children }: { children: React.ReactNode }) => children,
  useControls: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), centerView: vi.fn() }),
  useTransformComponent: () => 1,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

async function waitForPosition() {
  for (let attempt = 0; attempt < 10 && editorApi.setPosition.mock.calls.length === 0; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('EditorView openFile location', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reveals the requested line after the file and Monaco editor are ready', async () => {
    const ref = createRef<EditorViewHandle>()

    await act(async () => {
      root.render(<EditorView ref={ref} workingDir="/Users/example/project" />)
    })

    await act(async () => {
      ref.current?.openFile('src/app.tsx', 87, 12)
    })
    await waitForPosition()

    expect(editorApi.setPosition).toHaveBeenCalledWith({ lineNumber: 87, column: 12 })
    expect(editorApi.revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 87, column: 12 })
    expect(editorApi.focus).toHaveBeenCalled()
  })
})
