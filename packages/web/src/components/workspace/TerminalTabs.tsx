import React, { useState, useCallback, useRef } from "react"
import { ClipboardPaste, Plus, Server, Terminal, X } from "lucide-react"
import { toast } from "sonner"
import { Button, Spinner } from "@/design-system"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n"
import { Modal } from "@/components/ui/modal"
import { Textarea } from "@/components/ui/textarea"
import {
  StandaloneTerminalView,
  type StandaloneTerminalApi,
} from "./StandaloneTerminalView"
import { QuickCommandsPopover } from "./QuickCommandsPopover"
import { WorkspaceBackgroundServices } from "./WorkspaceBackgroundServices"
import type { QuickCommand } from "@agent-tower/shared"

// ============================================================
// Types
// ============================================================

interface TerminalTab {
  id: string
  order: number
}

export interface TerminalTabsProps {
  /** Working directory for new terminals */
  cwd?: string
  /** Whether this TerminalTabs container is currently visible */
  isVisible?: boolean
  /** Workspace scope for read-only background services */
  workspaceId?: string
  /** Quick commands from project config */
  quickCommands?: QuickCommand[]
}

// ============================================================
// Counter for unique tab labels
// ============================================================

let tabCounter = 0

function nextTab(): TerminalTab {
  tabCounter += 1
  return {
    id: `shell-${tabCounter}`,
    order: tabCounter,
  }
}

// ============================================================
// Component
// ============================================================

export const TerminalTabs: React.FC<TerminalTabsProps> = React.memo(
  function TerminalTabs({ cwd, isVisible = true, workspaceId, quickCommands = [] }) {
    const { t } = useI18n()
    // Start with one terminal tab by default
    const [tabs, setTabs] = useState<TerminalTab[]>(() => {
      return [nextTab()]
    })
    const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id)
    const [readyTabIds, setReadyTabIds] = useState<Set<string>>(() => new Set())
    const [isReadingClipboard, setIsReadingClipboard] = useState(false)
    const [isPasteSheetOpen, setIsPasteSheetOpen] = useState(false)
    const [pasteDraft, setPasteDraft] = useState("")
    const [pasteTargetTabId, setPasteTargetTabId] = useState<string | null>(null)
    const [activeView, setActiveView] = useState<'terminals' | 'services'>('terminals')
    const terminalApiMapRef = useRef<Map<string, StandaloneTerminalApi>>(new Map())
    const visibleView = workspaceId ? activeView : 'terminals'

    const removeTerminalApi = useCallback((tabId: string) => {
      terminalApiMapRef.current.delete(tabId)
      setReadyTabIds(prev => {
        if (!prev.has(tabId)) return prev
        const next = new Set(prev)
        next.delete(tabId)
        return next
      })
    }, [])

    // Add a new terminal tab
    const handleAddTab = useCallback(() => {
      const newTab = nextTab()
      setTabs(prev => [...prev, newTab])
      setActiveTabId(newTab.id)
    }, [])

    // Close a terminal tab
    const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      removeTerminalApi(tabId)
      setTabs(prev => {
        const next = prev.filter(t => t.id !== tabId)
        if (tabId === activeTabId && next.length > 0) {
          setActiveTabId(next[next.length - 1].id)
        }
        return next
      })
    }, [activeTabId, removeTerminalApi])

    // Handle terminal exit — remove the tab
    const handleTerminalExit = useCallback((tabId: string) => {
      removeTerminalApi(tabId)
      setTabs(prev => {
        const next = prev.filter(t => t.id !== tabId)
        if (tabId === activeTabId && next.length > 0) {
          setActiveTabId(next[next.length - 1].id)
        }
        return next
      })
    }, [activeTabId, removeTerminalApi])

    // Handle terminal ready — store the active input API
    const handleTerminalReady = useCallback((tabId: string, api: StandaloneTerminalApi) => {
      terminalApiMapRef.current.set(tabId, api)
      setReadyTabIds(prev => {
        if (prev.has(tabId)) return prev
        const next = new Set(prev)
        next.add(tabId)
        return next
      })
    }, [])

    // Execute quick command in active terminal
    const handleQuickCommand = useCallback((command: string) => {
      const api = terminalApiMapRef.current.get(activeTabId)
      if (api) {
        api.sendInput(command + '\r')
      }
    }, [activeTabId])

    const openPasteSheet = useCallback((tabId: string, initialValue = "") => {
      setPasteTargetTabId(tabId)
      setPasteDraft(initialValue)
      setIsPasteSheetOpen(true)
    }, [])

    const pasteIntoTerminal = useCallback((tabId: string, text: string) => {
      const api = terminalApiMapRef.current.get(tabId)
      if (!api) {
        toast.error(t("Terminal is not ready"))
        return false
      }
      api.paste(text)
      toast.success(t("Pasted into terminal"))
      return true
    }, [t])

    const handlePasteClick = useCallback(async () => {
      if (!terminalApiMapRef.current.has(activeTabId)) {
        toast.error(t("Terminal is not ready"))
        return
      }

      const clipboard = navigator.clipboard
      if (!clipboard?.readText) {
        openPasteSheet(activeTabId)
        return
      }

      setIsReadingClipboard(true)
      try {
        const text = await clipboard.readText()
        if (!text || text.includes("\n") || text.includes("\r")) {
          openPasteSheet(activeTabId, text)
          return
        }
        pasteIntoTerminal(activeTabId, text)
      } catch {
        openPasteSheet(activeTabId)
      } finally {
        setIsReadingClipboard(false)
      }
    }, [activeTabId, openPasteSheet, pasteIntoTerminal, t])

    const handleConfirmPaste = useCallback(() => {
      if (!pasteDraft || !pasteTargetTabId || !pasteIntoTerminal(pasteTargetTabId, pasteDraft)) return
      setIsPasteSheetOpen(false)
      setPasteDraft("")
      setPasteTargetTabId(null)
    }, [pasteDraft, pasteIntoTerminal, pasteTargetTabId])

    const handleClosePasteSheet = useCallback(() => {
      setIsPasteSheetOpen(false)
      setPasteDraft("")
      setPasteTargetTabId(null)
    }, [])

    const isActiveTerminalReady = readyTabIds.has(activeTabId)

    return (
      <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-terminal">
        {workspaceId && (
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-terminal-border bg-terminal-chrome px-2 select-none">
            <button
              type="button"
              onClick={() => setActiveView('terminals')}
              aria-pressed={visibleView === 'terminals'}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-muted-foreground',
                visibleView === 'terminals'
                  ? 'bg-terminal text-terminal-foreground'
                  : 'text-terminal-muted-foreground hover:bg-terminal-accent hover:text-terminal-foreground',
              )}
            >
              <Terminal size={12} aria-hidden="true" />
              {t('Interactive terminals')}
            </button>
            <button
              type="button"
              onClick={() => setActiveView('services')}
              aria-pressed={visibleView === 'services'}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terminal-muted-foreground',
                visibleView === 'services'
                  ? 'bg-terminal text-terminal-foreground'
                  : 'text-terminal-muted-foreground hover:bg-terminal-accent hover:text-terminal-foreground',
              )}
            >
              <Server size={12} aria-hidden="true" />
              {t('Background services')}
            </button>
          </div>
        )}

        <div
          aria-hidden={visibleView !== 'terminals'}
          className={cn(
            'min-h-0 flex-1 flex-col',
            visibleView === 'terminals' ? 'flex' : 'hidden',
          )}
        >
          {/* Terminal sub-tab bar */}
          <div className="flex items-center bg-terminal-chrome border-b border-terminal-border shrink-0 select-none">
            <div className="flex items-center overflow-x-auto scrollbar-app-thin flex-1 min-w-0">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-terminal-border whitespace-nowrap group transition-colors",
                    // 当前标签与终端同底色，像「接」在下面的终端上
                    tab.id === activeTabId
                      ? "bg-terminal text-terminal-foreground"
                      : "text-terminal-muted-foreground hover:bg-terminal-accent hover:text-terminal-foreground"
                  )}
                >
                  <Terminal size={11} className="shrink-0" />
                  <span>{t('Shell {count}', { count: tab.order })}</span>
                  {tabs.length > 1 && (
                    <span
                      onClick={(e) => handleCloseTab(tab.id, e)}
                      className="ml-1 p-0.5 rounded hover:bg-terminal-accent opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    >
                      <X size={10} />
                    </span>
                  )}
                </button>
              ))}
            </div>

            {tabs.length > 0 && (
              <>
                <span className="mx-0.5 block h-5 w-px shrink-0 bg-terminal-border md:hidden" aria-hidden="true" />
                <button
                  type="button"
                  onClick={handlePasteClick}
                  disabled={!isActiveTerminalReady || isReadingClipboard}
                  className="flex h-11 w-11 shrink-0 items-center justify-center text-terminal-muted-foreground transition-colors hover:bg-terminal-accent hover:text-terminal-foreground active:bg-terminal-accent disabled:cursor-not-allowed disabled:opacity-40 md:hidden"
                  title={t("Paste into terminal")}
                  aria-label={t("Paste into terminal")}
                >
                  {isReadingClipboard
                    ? <Spinner size="lg" className="size-[18px]" />
                    : <ClipboardPaste size={18} />}
                </button>
              </>
            )}

            {/* Add terminal button */}
            <button
              type="button"
              onClick={handleAddTab}
              className="flex h-11 w-11 shrink-0 items-center justify-center text-terminal-muted-foreground transition-colors hover:bg-terminal-accent hover:text-terminal-foreground active:bg-terminal-accent md:h-auto md:w-auto md:px-2 md:py-1.5"
              title={t('New Terminal')}
              aria-label={t('New Terminal')}
            >
              <Plus size={14} />
            </button>

            {/* Quick commands button */}
            {quickCommands.length > 0 && (
              <QuickCommandsPopover
                commands={quickCommands}
                onSelect={handleQuickCommand}
              />
            )}
          </div>

          {/* Terminal content area */}
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
            {tabs.length === 0 ? (
              <div className="flex-1 flex items-center justify-center h-full text-terminal-muted-foreground">
                <div className="flex flex-col items-center gap-2">
                  <Terminal size={28} />
                  <span className="text-xs">{t('No terminals open')}</span>
                  <button
                    onClick={handleAddTab}
                    className="mt-1 rounded bg-terminal-chrome px-3 py-1 text-xs text-terminal-foreground ring-1 ring-inset ring-terminal-border transition-colors hover:bg-terminal-accent"
                  >
                    {t('New Terminal')}
                  </button>
                </div>
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  aria-hidden={tab.id !== activeTabId}
                  className={cn(
                    "absolute inset-0 h-full w-full min-h-0 min-w-0 overflow-hidden",
                    tab.id === activeTabId
                      ? "visible pointer-events-auto"
                      : "invisible pointer-events-none"
                  )}
                >
                  <StandaloneTerminalView
                    cwd={cwd}
                    isVisible={isVisible && visibleView === 'terminals' && tab.id === activeTabId}
                    onExit={() => handleTerminalExit(tab.id)}
                    onReady={(api) => handleTerminalReady(tab.id, api)}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {workspaceId && visibleView === 'services' && (
          <div className="min-h-0 flex-1">
            <WorkspaceBackgroundServices workspaceId={workspaceId} enabled={isVisible} />
          </div>
        )}

        <Modal
          isOpen={isPasteSheetOpen}
          onClose={handleClosePasteSheet}
          title={t("Paste into terminal")}
          // 手机上贴底弹出（底部抽屉），sm 起回到居中的对话框
          className="max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[70dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-lg max-sm:border-x-0 max-sm:border-b-0"
          action={
            <>
              <Button variant="ghost" size="lg" onClick={handleClosePasteSheet} className="max-sm:h-11">
                {t("Cancel")}
              </Button>
              <Button variant="primary" size="lg" onClick={handleConfirmPaste} disabled={!pasteDraft} className="max-sm:h-11">
                {t("Paste")}
              </Button>
            </>
          }
        >
          <Textarea
            autoFocus
            value={pasteDraft}
            onChange={(event) => setPasteDraft(event.target.value)}
            placeholder={t("Paste terminal input here")}
            aria-label={t("Terminal paste content")}
            className="min-h-32 resize-none bg-background font-mono"
          />
        </Modal>
      </div>
    )
  }
)
