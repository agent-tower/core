import React, { useEffect, useRef, useCallback, useLayoutEffect } from "react"
import { Terminal as XTerm } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import "xterm/css/xterm.css"
import "./terminal.css"

import { useStandaloneTerminal } from "@/lib/socket/hooks/useStandaloneTerminal"
import { useXtermAutoFit } from "./useXtermAutoFit"

// ============================================================
// Types
// ============================================================

export interface StandaloneTerminalViewProps {
  /** Working directory for the terminal */
  cwd?: string
  /** Whether this terminal's container is currently visible (not display:none) */
  isVisible?: boolean
  /** Called when the terminal process exits */
  onExit?: (exitCode: number) => void
  /** Called when terminal is ready, exposes sendInput for external command injection */
  onReady?: (api: { sendInput: (data: string) => void }) => void
}

// ============================================================
// xterm theme (shared with TerminalView)
// ============================================================

const XTERM_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#6a9955",
  yellow: "#d7ba7d",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f44747",
  brightGreen: "#6a9955",
  brightYellow: "#d7ba7d",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
} as const

// ============================================================
// Component
// ============================================================

export const StandaloneTerminalView: React.FC<StandaloneTerminalViewProps> = React.memo(
  function StandaloneTerminalView({ cwd, isVisible = true, onExit, onReady }) {
    const terminalRef = useRef<HTMLDivElement>(null)
    const xtermRef = useRef<XTerm | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const createdRef = useRef(false)

    const {
      terminalId,
      isAttached,
      needsRecreate,
      create,
      sendInput,
      resize,
    } = useStandaloneTerminal({
      cwd,
      onOutput: useCallback((data: string) => {
        xtermRef.current?.write(data)
      }, []),
      onExit: useCallback((exitCode: number) => {
        xtermRef.current?.writeln(
          `\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`
        )
        onExit?.(exitCode)
      }, [onExit]),
    })
    const { scheduleFit } = useXtermAutoFit({
      terminalRef,
      xtermRef,
      fitAddonRef,
      isVisible,
      onResize: resize,
    })

    useEffect(() => {
      if (isVisible) return
      xtermRef.current?.blur()
    }, [isVisible])

    // Auto-recreate terminal after socket reconnect
    useEffect(() => {
      if (!needsRecreate) return
      const xterm = xtermRef.current
      if (xterm) {
        xterm.writeln('\r\n\x1b[33m[Terminal disconnected — reconnecting...]\x1b[0m')
      }
      create()
    }, [needsRecreate, create])

    // Initialize xterm
    useLayoutEffect(() => {
      if (!terminalRef.current) return

      const xterm = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
        lineHeight: 1.4,
        theme: XTERM_THEME,
        scrollback: 5000,
        convertEol: true,
      })

      const fitAddon = new FitAddon()
      xterm.loadAddon(fitAddon)
      xterm.open(terminalRef.current)

      xtermRef.current = xterm
      fitAddonRef.current = fitAddon
      scheduleFit(8)

      return () => {
        xterm.dispose()
        xtermRef.current = null
        fitAddonRef.current = null
      }
    }, [scheduleFit])

    // Auto-create terminal on mount
    useEffect(() => {
      if (createdRef.current) return
      createdRef.current = true
      create()
    }, [create])

    // Forward keyboard input to PTY
    useEffect(() => {
      const xterm = xtermRef.current
      if (!xterm || !isAttached) return

      const disposable = xterm.onData((data) => {
        sendInput(data)
      })

      return () => disposable.dispose()
    }, [sendInput, isAttached])

    // Expose sendInput to parent when terminal is attached
    useEffect(() => {
      if (isAttached) {
        scheduleFit(4)
        onReady?.({ sendInput })
      }
    }, [isAttached, onReady, scheduleFit, sendInput])

    return (
      <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#1e1e1e]">
        {/* Terminal loading overlay */}
        {!terminalId && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-xs z-10 bg-[#1e1e1e]">
            Starting terminal...
          </div>
        )}
        {/* Terminal body — 始终渲染以确保 xterm 有正确尺寸的容器 */}
        <div
          ref={terminalRef}
          className="terminal-xterm-host flex-1 min-h-0 min-w-0 w-full overflow-hidden"
        />
      </div>
    )
  }
)
