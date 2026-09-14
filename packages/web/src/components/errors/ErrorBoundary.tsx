import { Component, type ErrorInfo, type ReactNode } from 'react'
import { logClientError } from '@/lib/error-log'

export interface ErrorBoundaryFallbackProps {
  error: Error
  /** Clear the caught error and render `children` again. */
  reset: () => void
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Rendered instead of `children` after a descendant throws. */
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode
  /** Stable identifier written to the error log, e.g. `log-view`. */
  source: string
  /** Extra, non-sensitive facts written to the error log. */
  metadata?: Record<string, unknown>
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Minimal render-error backstop.
 *
 * React only catches render errors in class components, so this stays a class
 * even though the rest of the app is function components. `reset()` re-renders
 * the children: if the failing condition is gone (new data arrived, a transient
 * bad entry was replaced) the view recovers without a page reload. `reset()`
 * does not change the data, so retrying a still-broken entry throws again.
 *
 * Scope (the reason this comment is explicit): React delivers errors thrown
 * while rendering a descendant, and errors from a descendant's lifecycle
 * methods or constructor, to this boundary. Errors raised outside that phase -
 * DOM event handlers, timers, promise rejections, ResizeObserver/other observer
 * callbacks, socket callbacks - are never delivered to
 * `getDerivedStateFromError`/`componentDidCatch`; they also do not unmount the
 * React tree, but they do need their own handling. This component therefore
 * promises containment for render-phase errors only.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logClientError(this.props.source, error, {
      componentStack: info.componentStack,
      metadata: this.props.metadata,
    })
    this.props.onError?.(error, info)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      return this.props.fallback({ error, reset: this.reset })
    }
    return this.props.children
  }
}
