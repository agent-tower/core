import { describe, expect, it } from 'vitest'
import { hasMermaidCodeBlock } from '../streamdown-mermaid'

describe('streamdown mermaid helpers', () => {
  it('detects mermaid fenced code blocks for lazy diagram rendering', () => {
    expect(hasMermaidCodeBlock('Plain markdown without diagrams')).toBe(false)
    expect(hasMermaidCodeBlock('```ts\nconst value = 1\n```')).toBe(false)
    expect(hasMermaidCodeBlock('```mermaid\nflowchart TD\n  A --> B\n```')).toBe(true)
    expect(hasMermaidCodeBlock('~~~MERMAID\nsequenceDiagram\n  A->>B: hi\n~~~')).toBe(true)
  })
})
