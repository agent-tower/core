import { useEffect, useState } from 'react'
import type { StreamdownProps } from 'streamdown'

const MERMAID_CODE_BLOCK_PATTERN = /(^|\n)(```|~~~)[^\S\r\n]*mermaid(?:[\s\r\n]|$)/i

let streamdownMermaidPluginsPromise: Promise<StreamdownProps['plugins']> | null = null

export function hasMermaidCodeBlock(content: string) {
  return MERMAID_CODE_BLOCK_PATTERN.test(content)
}

function loadStreamdownMermaidPlugins() {
  streamdownMermaidPluginsPromise ??= import('@streamdown/mermaid').then(({ mermaid }) => ({ mermaid }))
  return streamdownMermaidPluginsPromise
}

export function useStreamdownMermaidPlugins(content: string) {
  const shouldLoadMermaid = hasMermaidCodeBlock(content)
  const [plugins, setPlugins] = useState<StreamdownProps['plugins']>()

  useEffect(() => {
    if (!shouldLoadMermaid) {
      setPlugins(undefined)
      return
    }

    let isActive = true
    loadStreamdownMermaidPlugins()
      .then((loadedPlugins) => {
        if (isActive) setPlugins(loadedPlugins)
      })
      .catch(() => {
        streamdownMermaidPluginsPromise = null
        if (isActive) setPlugins(undefined)
      })

    return () => {
      isActive = false
    }
  }, [shouldLoadMermaid])

  return shouldLoadMermaid ? plugins : undefined
}
