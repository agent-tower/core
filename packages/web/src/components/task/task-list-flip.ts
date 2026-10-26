import { createContext } from 'react'

export interface FlipHandle {
  registry: Map<string, HTMLElement>
}

export const FlipContext = createContext<FlipHandle | null>(null)
