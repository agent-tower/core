import { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import type { AgentType } from '@agent-tower/shared'
import { getAgentMeta } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'

interface AgentLogoProps {
  agentType?: AgentType | string | null
  className?: string
  fallbackClassName?: string
}

export function AgentLogo({
  agentType,
  className,
  fallbackClassName,
}: AgentLogoProps) {
  const meta = getAgentMeta(agentType)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [meta?.logoSrc])

  if (!meta || failed) {
    return (
      <Cpu
        aria-hidden="true"
        className={cn('shrink-0 text-muted-foreground', className, fallbackClassName)}
      />
    )
  }

  return (
    <img
      src={meta.logoSrc}
      alt=""
      aria-hidden="true"
      className={cn('shrink-0 object-contain', className)}
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
