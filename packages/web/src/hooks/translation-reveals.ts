import { useMemo } from 'react'

type Source = { id: string; revision: number; streaming?: boolean }
type Overlay = { id: string; version: string; state: string }

/** A view owns presentation events independently of REST/query/virtual row lifetimes. */
export class TranslationReveals {
  private initialized = false
  private sources = new Map<string, number>()
  private live = new Set<string>()
  private pending = new Set<string>()
  private completed = new Set<string>()
  private eligible = new Set<string>()
  private consumed = new Set<string>()

  update(sources: Source[], overlays: Overlay[], hasContent: boolean) {
    for (const source of sources) {
      const previous = this.sources.get(source.id)
      if (source.streaming || this.initialized && (previous === undefined || previous !== source.revision)) this.live.add(source.id)
      this.sources.set(source.id, source.revision)
    }
    if (hasContent) this.initialized = true
    for (const overlay of overlays) {
      if (overlay.state !== 'SUCCESS') {
        if (overlay.state !== 'NOT_REQUIRED') this.pending.add(overlay.version)
      } else if (!this.completed.has(overlay.version)) {
        this.completed.add(overlay.version)
        if (this.live.has(overlay.id) || this.pending.has(overlay.version)) this.eligible.add(overlay.version)
      }
    }
  }

  /** A presentation version may list several overlay versions; each one plays at most once. */
  claim = (version: string) => version.split(' ').map(item => {
    if (this.consumed.has(item)) return false
    this.consumed.add(item)
    return this.eligible.has(item)
  }).includes(true)
}

export function useTranslationReveals(scope: string, sources: Source[], overlays: Overlay[], hasContent: boolean) {
  // A scope change starts a new view even if the transcript has identical bytes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const events = useMemo(() => new TranslationReveals(), [scope])
  events.update(sources, overlays, hasContent)
  return events.claim
}
