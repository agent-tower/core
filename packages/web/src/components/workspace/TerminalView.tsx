import React, { useEffect, useRef, useCallback, useLayoutEffect } from "react"
import { Terminal as XTerm } from "xterm"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, Wifi, WifiOff, Loader2 } from "lucide-react"
import "xterm/css/xterm.css"
import "./terminal.css"

import { useI18n } from "@/lib/i18n"
import { useTerminal } from "@/lib/socket/hooks/useTerminal"
import { useXtermAutoFit } from "./useXtermAutoFit"

// ============================================================
// Types
// ============================================================

export interface TerminalViewProps {
  /** Session ID 用于接入 Agent PTY 流 */
  sessionId?: string
}

// ============================================================
// 连接状态指示器
// ============================================================

type ConnectionStatus = "disconnected" | "connecting" | "connected"

const StatusIndicator: React.FC<{ status: ConnectionStatus }> = ({ status }) => {
  const { t } = useI18n()
  const config = {
    disconnected: {
      icon: <WifiOff size={12} />,
      label: "Disconnected",
      dotClass: "bg-neutral-500",
      textClass: "text-neutral-500",
    },
    connecting: {
      icon: <Loader2 size={12} className="animate-spin" />,
      label: "Connecting...",
      dotClass: "bg-amber-500 animate-pulse",
      textClass: "text-amber-500",
    },
    connected: {
      icon: <Wifi size={12} />,
      label: "Connected",
      dotClass: "bg-emerald-500",
      textClass: "text-emerald-500",
    },
  }

  const { icon, label, dotClass, textClass } = config[status]

  return (
    <div className={`flex items-center gap-1.5 text-[11px] ${textClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      {icon}
      <span>{t(label)}</span>
    </div>
  )
}

// ============================================================
// 空状态占位
// ============================================================

const NoSessionPlaceholder: React.FC = () => {
  const { t } = useI18n()

  return (
    <div className="flex-1 flex items-center justify-center bg-[#1e1e1e]">
      <div className="flex flex-col items-center gap-3 text-neutral-500">
        <Terminal size={32} />
        <span className="text-sm">{t('No active session')}</span>
        <span className="text-xs text-neutral-600 max-w-[280px] text-center">
          {t('Create a workspace and start a session to see terminal output.')}
        </span>
      </div>
    </div>
  )
}

// ============================================================
// 主组件
// ============================================================

export const TerminalView: React.FC<TerminalViewProps> = React.memo(
  function TerminalView({ sessionId }) {
    if (!sessionId) {
      return <NoSessionPlaceholder />
    }
    return <TerminalInstance sessionId={sessionId} />
  }
)

// ============================================================
// 终端实例（有 sessionId 时渲染）
// ============================================================

interface TerminalInstanceProps {
  sessionId: string
}

const TerminalInstance: React.FC<TerminalInstanceProps> = ({ sessionId }) => {
  const { t } = useI18n()
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const { isConnected, isAttached, attach, sendInput, resize } = useTerminal({
    sessionId,
    onOutput: useCallback((data: string) => {
      xtermRef.current?.write(data)
    }, []),
    onExit: useCallback((exitCode: number) => {
      xtermRef.current?.writeln(
        `\r\n\x1b[90m[${t('Process exited with code {code}', { code: exitCode })}]\x1b[0m`
      )
    }, [t]),
    onError: useCallback((message: string) => {
      xtermRef.current?.writeln(`\r\n\x1b[31m[${t('Error: {message}', { message })}]\x1b[0m`)
    }, [t]),
  })
  const { scheduleFit } = useXtermAutoFit({
    terminalRef,
    xtermRef,
    fitAddonRef,
    onResize: resize,
  })

  // 计算连接状态
  const connectionStatus: ConnectionStatus = isAttached
    ? "connected"
    : isConnected
      ? "connecting"
      : "disconnected"

  // 初始化 xterm
  useLayoutEffect(() => {
    if (!terminalRef.current) return

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      lineHeight: 1.4,
      theme: {
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
      },
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

  // 键盘输入转发到 PTY
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return

    const disposable = xterm.onData((data) => {
      sendInput(data)
    })

    return () => disposable.dispose()
  }, [sendInput])

  // 连接后自动 attach
  useEffect(() => {
    if (isConnected && !isAttached) {
      attach()
    }
    if (isConnected || isAttached) {
      scheduleFit(4)
    }
  }, [attach, isAttached, isConnected, scheduleFit])

  return (
    <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#1e1e1e] text-neutral-200 font-mono text-xs">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#252526] border-b border-[#333] shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={13} className="text-neutral-500" />
          <span className="text-[11px] text-neutral-400 select-none">
            {t('Session: {id}', { id: `${sessionId.slice(0, 8)}...` })}
          </span>
        </div>
        <StatusIndicator status={connectionStatus} />
      </div>

      {/* Terminal Body */}
      <div
        ref={terminalRef}
        className="terminal-xterm-host flex-1 min-h-0 min-w-0 w-full overflow-hidden"
      />
    </div>
  )
}
