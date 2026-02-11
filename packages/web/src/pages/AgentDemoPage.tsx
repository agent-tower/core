import { useState, useEffect, useRef, useCallback } from 'react'
import { apiClient } from '@/lib/api-client'
import { useNormalizedLogs } from '@/lib/socket/hooks/useNormalizedLogs'
import { LogStream, IconRunning, IconDone, IconPending } from '@/components/agent'
import { Button } from '@/components/ui/button'
import { useAgentVariants } from '@/hooks/use-profiles'
import { Link } from 'react-router-dom'
import { Send, Square, Paperclip, AtSign, Hash, Globe, ChevronDown, ChevronUp, Settings } from 'lucide-react'

// Debug 日志开关
const DEBUG_PAGE = true;

interface Agent {
  type: string
  name: string
  available: boolean
  version?: string
  error?: string
}

type SessionStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error'

export function AgentDemoPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [selectedVariant, setSelectedVariant] = useState<string>('DEFAULT')
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle')
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false)
  const [input, setInput] = useState('')

  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 获取当前选中 agent 的 variant 列表
  const { data: variantsData } = useAgentVariants(selectedAgent)
  const variantNames = variantsData ? Object.keys(variantsData) : ['DEFAULT']

  // 切换 agent 时重置 variant
  const handleSelectAgent = (agentType: string) => {
    setSelectedAgent(agentType)
    setSelectedVariant('DEFAULT')
  }

  // 处理退出
  const handleExit = useCallback((exitCode: number) => {
    setSessionStatus(exitCode === 0 ? 'stopped' : 'error')
  }, [])

  const handleError = useCallback((message: string) => {
    console.error('Agent error:', message)
    setSessionStatus('error')
  }, [])

  // 使用标准化日志 hook
  const {
    isConnected,
    isAttached,
    logs,
    agentSessionId,
    attach,
    clearLogs,
  } = useNormalizedLogs({
    sessionId: sessionId || '',
    onExit: handleExit,
    onError: handleError,
  })

  // 加载可用 agents
  useEffect(() => {
    apiClient.get<{ agents: Agent[] }>('/demo/agents').then(res => {
      setAgents(res.agents)
      const available = res.agents.find(a => a.available)
      if (available) {
        setSelectedAgent(available.type)
      }
    })
  }, [])

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // 当 sessionId 变化且 socket 已连接时，自动 attach
  useEffect(() => {
    if (DEBUG_PAGE) {
      console.log(`[AgentDemoPage:useEffect] t=${Date.now()} sessionId=${sessionId} isConnected=${isConnected} isAttached=${isAttached}`);
    }
    if (sessionId && isConnected && !isAttached) {
      if (DEBUG_PAGE) {
        console.log(`[AgentDemoPage:useEffect] t=${Date.now()} calling attach()`);
      }
      attach()
    }
  }, [sessionId, isConnected, isAttached, attach])

  // Handle textarea auto-resize
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      const maxHeight = 210
      const newHeight = Math.min(textareaRef.current.scrollHeight, maxHeight)
      textareaRef.current.style.height = `${newHeight}px`
    }
  }

  // 启动会话
  const handleStart = async () => {
    if (!selectedAgent || !prompt.trim()) return

    const startTime = Date.now();
    if (DEBUG_PAGE) {
      console.log(`[AgentDemoPage:handleStart] t=${startTime} starting...`);
    }

    setSessionStatus('starting')
    clearLogs()

    try {
      const res = await apiClient.post<{ sessionId: string }>('/demo/start', {
        agentType: selectedAgent,
        prompt: prompt.trim(),
        variant: selectedVariant,
      })
      if (DEBUG_PAGE) {
        console.log(`[AgentDemoPage:handleStart] t=${Date.now()} apiTime=${Date.now() - startTime}ms sessionId=${res.sessionId}`);
      }
      setSessionId(res.sessionId)
      setSessionStatus('running')
    } catch (error) {
      console.error('Start failed:', error)
      setSessionStatus('error')
    }
  }

  // 发送后续消息
  const handleSendMessage = async () => {
    if (!sessionId || !input.trim()) return

    const message = input.trim()
    setInput('')

    try {
      await apiClient.post(`/demo/${sessionId}/message`, { message })
    } catch (error) {
      console.error('Send failed:', error)
    }
  }

  // 停止会话
  const handleStop = async () => {
    if (!sessionId) return

    try {
      await apiClient.post(`/demo/${sessionId}/stop`)
      setSessionStatus('stopped')
    } catch (error) {
      console.error('Stop failed:', error)
    }
  }

  // 重新开始
  const handleReset = () => {
    setSessionId(null)
    setSessionStatus('idle')
    setPrompt('')
    setInput('')
    clearLogs()
  }

  const isRunning = sessionStatus === 'running'
  const hasSession = sessionId !== null

  // 获取当前选中的 agent 信息
  const currentAgent = agents.find(a => a.type === selectedAgent)

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="px-8 py-5 border-b border-neutral-100 bg-white transition-all duration-300">
        {/* Row 1: Title & Status */}
        <div className="flex items-center flex-wrap gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-medium text-blue-600">
              Agent Demo
            </span>
            <span className="text-neutral-300 text-sm">/</span>
            <span className="text-xl font-bold text-neutral-900 tracking-tight">
              {hasSession ? (prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '')) : '新会话'}
            </span>
          </div>

          {/* Status Indicators */}
          <div className="flex items-center">
            {sessionStatus === 'running' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs font-medium border border-blue-100">
                <IconRunning className="w-3.5 h-3.5 animate-pulse" />
                <span>Running</span>
              </div>
            )}
            {sessionStatus === 'stopped' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium border border-emerald-100">
                <IconDone className="w-3.5 h-3.5" />
                <span>Done</span>
              </div>
            )}
            {sessionStatus === 'idle' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-neutral-100 text-neutral-600 rounded-full text-xs font-medium border border-neutral-200">
                <IconPending className="w-3.5 h-3.5" />
                <span>Idle</span>
              </div>
            )}
            {sessionStatus === 'starting' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-medium border border-amber-100">
                <IconRunning className="w-3.5 h-3.5 animate-spin" />
                <span>Starting...</span>
              </div>
            )}
            {sessionStatus === 'error' && (
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-red-50 text-red-700 rounded-full text-xs font-medium border border-red-100">
                <span>Error</span>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Description (when has session) */}
        {hasSession && (
          <div className="mt-1.5 flex items-start gap-2 group max-w-4xl">
            <div
              className={`text-sm text-neutral-600 leading-relaxed cursor-pointer transition-all ${isDescriptionExpanded ? '' : 'truncate'}`}
              onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
            >
              {prompt}
            </div>
            <button
              onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
              className="mt-0.5 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-600 transition-opacity"
            >
              {isDescriptionExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        )}

        {/* Row 3: Meta Info */}
        <div className="flex items-center gap-6 mt-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-neutral-400 font-medium">Agent</span>
            <div className="flex items-center gap-1.5 text-neutral-900 font-medium bg-neutral-50 px-2 py-1 rounded border border-neutral-100">
              {currentAgent?.name || selectedAgent || '未选择'}
            </div>
          </div>
          {selectedVariant !== 'DEFAULT' && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-neutral-400 font-medium">Variant</span>
              <div className="flex items-center gap-1.5 text-neutral-700 font-medium bg-blue-50 px-2 py-1 rounded border border-blue-100">
                {selectedVariant}
              </div>
            </div>
          )}
          {agentSessionId && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-neutral-400 font-medium">Session</span>
              <div className="flex items-center gap-1.5 text-neutral-700 font-mono bg-neutral-50 px-2 py-1 rounded border border-neutral-100">
                {agentSessionId.slice(0, 8)}...
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-neutral-400 font-medium">连接</span>
            <div className={`flex items-center gap-1.5 font-medium px-2 py-1 rounded border ${
              isConnected
                ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
                : 'text-neutral-500 bg-neutral-50 border-neutral-100'
            }`}>
              {isConnected ? (isAttached ? '已连接' : '连接中...') : '未连接'}
            </div>
          </div>
          {hasSession && (
            <Button variant="outline" size="sm" onClick={handleReset} className="ml-auto">
              新会话
            </Button>
          )}
          <Link
            to="/settings/profiles"
            className={`flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 transition-colors ${hasSession ? '' : 'ml-auto'}`}
          >
            <Settings size={14} />
            <span>Profiles 设置</span>
          </Link>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {!hasSession ? (
          /* Agent Selection & Prompt Input */
          <div className="max-w-2xl mx-auto space-y-6">
            <div>
              <h2 className="text-lg font-semibold mb-3 text-neutral-900">选择 Agent</h2>
              <div className="flex gap-2 flex-wrap">
                {agents.map(agent => (
                  <Button
                    key={agent.type}
                    variant={selectedAgent === agent.type ? 'default' : 'outline'}
                    disabled={!agent.available}
                    onClick={() => handleSelectAgent(agent.type)}
                  >
                    {agent.name}
                    {agent.available && agent.version && ` (${agent.version})`}
                    {!agent.available && ' (不可用)'}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-semibold mb-3 text-neutral-900">配置变体 (Profile Variant)</h2>
              <div className="flex gap-2 flex-wrap">
                {variantNames.map(v => (
                  <button
                    key={v}
                    onClick={() => setSelectedVariant(v)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                      selectedVariant === v
                        ? 'bg-neutral-900 text-white border-neutral-900'
                        : 'bg-white text-neutral-600 border-neutral-200 hover:border-neutral-400'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              {variantsData && variantsData[selectedVariant] && (
                <p className="mt-2 text-xs text-neutral-500 font-mono">
                  {Object.entries(variantsData[selectedVariant])
                    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                    .join(', ')}
                </p>
              )}
            </div>

            <div>
              <h2 className="text-lg font-semibold mb-3 text-neutral-900">输入任务</h2>
              <div className="relative border border-neutral-200 rounded-xl shadow-sm bg-white focus-within:ring-1 focus-within:ring-neutral-300 focus-within:border-neutral-300 transition-all duration-200">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  placeholder="描述你想让 Agent 完成的任务..."
                  className="w-full px-4 py-3 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-neutral-900 placeholder-neutral-400 leading-relaxed text-sm"
                />
                <div className="flex items-center justify-end px-3 pb-3 pt-1">
                  <Button
                    onClick={handleStart}
                    disabled={sessionStatus === 'starting' || !selectedAgent || !prompt.trim()}
                  >
                    {sessionStatus === 'starting' ? '启动中...' : '开始'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Log Stream */
          <div className="min-h-[200px]">
            {logs.length === 0 ? (
              <div className="text-neutral-400 text-center py-8">等待 Agent 响应...</div>
            ) : (
              <LogStream logs={logs} />
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input Area (when has session) */}
      {hasSession && (
        <div className="px-8 py-6 border-t border-neutral-100 bg-white">
          <div className="relative border border-neutral-200 rounded-xl shadow-sm bg-white focus-within:ring-1 focus-within:ring-neutral-300 focus-within:border-neutral-300 transition-all duration-200">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              rows={3}
              placeholder="发送消息给 Agent..."
              className="w-full px-4 py-3 bg-transparent border-none focus:outline-none focus:ring-0 resize-none text-neutral-900 placeholder-neutral-400 leading-relaxed text-sm scrollbar-thin scrollbar-thumb-neutral-200 scrollbar-track-transparent"
              style={{ minHeight: '80px', maxHeight: '210px' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSendMessage()
                }
              }}
            />

            <div className="flex items-center justify-between px-3 pb-3 pt-1 border-t border-transparent">
              {/* Left Toolbar */}
              <div className="flex items-center gap-1 text-neutral-400">
                <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Attach File">
                  <Paperclip size={18} />
                </button>
                <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Mention">
                  <AtSign size={18} />
                </button>
                <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Reference Issue">
                  <Hash size={18} />
                </button>
                <div className="w-px h-4 bg-neutral-200 mx-1"></div>
                <button className="p-2 hover:bg-neutral-100 hover:text-neutral-600 rounded-lg transition-colors" title="Search Web">
                  <Globe size={18} />
                </button>
              </div>

              {/* Right Actions */}
              <div className="flex items-center gap-2">
                {isRunning && (
                  <button
                    onClick={handleStop}
                    className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                  >
                    <Square size={12} fill="currentColor" />
                    <span>Stop</span>
                  </button>
                )}
                <button
                  onClick={handleSendMessage}
                  disabled={!input.trim()}
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg transition-all ${
                    input.trim()
                      ? 'bg-neutral-900 text-white hover:bg-black shadow-sm'
                      : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                  }`}
                >
                  <span>Send</span>
                  <Send size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
