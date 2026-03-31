import { useState, useEffect, useRef, useCallback } from 'react'
import { apiClient } from '@/lib/api-client'
import { useTerminal } from '@/lib/socket/hooks/useTerminal'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useI18n } from '@/lib/i18n'

interface Agent {
  type: string
  name: string
  available: boolean
  version?: string
  error?: string
}

interface Message {
  role: 'user' | 'agent'
  content: string
  timestamp: Date
}

export function DemoPage() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [followUpMessage, setFollowUpMessage] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 处理 agent 输出
  const handleOutput = useCallback((data: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'agent') {
        // 追加到最后一条 agent 消息
        return [
          ...prev.slice(0, -1),
          { ...last, content: last.content + data },
        ]
      }
      // 创建新的 agent 消息
      return [...prev, { role: 'agent', content: data, timestamp: new Date() }]
    })
  }, [])

  const handleExit = useCallback((exitCode: number) => {
    setMessages(prev => [
      ...prev,
      { role: 'agent', content: `\n[进程退出，退出码: ${exitCode}]`, timestamp: new Date() },
    ])
    setSessionId(null)
  }, [])

  const handleError = useCallback((message: string) => {
    setMessages(prev => [
      ...prev,
      { role: 'agent', content: `\n[错误: ${message}]`, timestamp: new Date() },
    ])
  }, [])

  // 使用 terminal hook
  const { isConnected, isAttached, attach } = useTerminal({
    sessionId: sessionId || '',
    onOutput: handleOutput,
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 当 sessionId 变化且 socket 已连接时，自动 attach
  useEffect(() => {
    if (sessionId && isConnected && !isAttached) {
      attach()
    }
  }, [sessionId, isConnected, isAttached, attach])

  // 启动会话
  const handleStart = async () => {
    if (!selectedAgent || !prompt.trim()) return

    setIsLoading(true)
    setMessages([{ role: 'user', content: prompt, timestamp: new Date() }])

    try {
      const res = await apiClient.post<{ sessionId: string }>('/demo/start', {
        agentType: selectedAgent,
        prompt: prompt.trim(),
      })
      setSessionId(res.sessionId)
      setPrompt('')
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          role: 'agent',
          content: t('启动失败: {message}', { message: error instanceof Error ? error.message : t('未知错误') }),
          timestamp: new Date(),
        },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  // 发送后续消息
  const handleSendMessage = async () => {
    if (!sessionId || !followUpMessage.trim()) return

    const message = followUpMessage.trim()
    setMessages(prev => [...prev, { role: 'user', content: message, timestamp: new Date() }])
    setFollowUpMessage('')

    try {
      await apiClient.post(`/demo/${sessionId}/message`, { message })
    } catch (error) {
      setMessages(prev => [
        ...prev,
        {
          role: 'agent',
          content: t('发送失败: {message}', { message: error instanceof Error ? error.message : t('未知错误') }),
          timestamp: new Date(),
        },
      ])
    }
  }

  // 停止会话
  const handleStop = async () => {
    if (!sessionId) return

    try {
      await apiClient.post(`/demo/${sessionId}/stop`)
      setMessages(prev => [
        ...prev,
        { role: 'agent', content: `\n[${t('会话已停止')}]`, timestamp: new Date() },
      ])
      setSessionId(null)
    } catch (error) {
      console.error('Stop failed:', error)
    }
  }

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto p-4 gap-4">
      <h1 className="text-2xl font-bold">{t('Agent 交互演示')}</h1>

      {/* Agent 选择 */}
      {!sessionId && (
        <Card className="p-4">
          <h2 className="text-lg font-semibold mb-3">{t('选择 Agent')}</h2>
          <div className="flex gap-2 flex-wrap mb-4">
            {agents.map(agent => (
              <Button
                key={agent.type}
                variant={selectedAgent === agent.type ? 'default' : 'outline'}
                disabled={!agent.available}
                onClick={() => setSelectedAgent(agent.type)}
              >
                {agent.name}
                {agent.available && agent.version && ` (${agent.version})`}
                {!agent.available && t(' (不可用)')}
              </Button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && handleStart()}
              placeholder={t('输入你的问题或任务...')}
              className="flex-1 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Button onClick={handleStart} disabled={isLoading || !selectedAgent || !prompt.trim()}>
              {isLoading ? t('启动中...') : t('开始')}
            </Button>
          </div>
        </Card>
      )}

      {/* 消息显示区域 */}
      <Card className="flex-1 p-4 overflow-hidden flex flex-col">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">{t('对话')}</h2>
          {sessionId && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">
                {isConnected ? (isAttached ? t('已连接') : t('连接中...')) : t('未连接')}
              </span>
              <Button variant="outline" size="sm" onClick={handleStop}>
                {t('停止')}
              </Button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto space-y-3">
          {messages.length === 0 ? (
            <div className="text-gray-400 text-center py-8">{t('选择 Agent 并输入问题开始对话')}</div>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={idx}
                className={`p-3 rounded-lg ${
                  msg.role === 'user'
                    ? 'bg-blue-100 ml-8'
                    : 'bg-gray-100 mr-8'
                }`}
              >
                <div className="text-xs text-gray-500 mb-1">
                  {msg.role === 'user' ? t('你') : 'Agent'}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-sm">{msg.content}</pre>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 后续消息输入 */}
        {sessionId && (
          <div className="flex gap-2 mt-3 pt-3 border-t">
            <input
              type="text"
              value={followUpMessage}
              onChange={e => setFollowUpMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && handleSendMessage()}
              placeholder={t('发送后续消息...')}
              className="flex-1 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Button onClick={handleSendMessage} disabled={!followUpMessage.trim()}>
              {t('发送')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
