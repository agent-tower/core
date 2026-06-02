import { describe, expect, it } from 'vitest'
import { getTunnelAlertDiagnostics } from '../TunnelButton'
import type { TunnelStatus } from '@/hooks/use-tunnel'

function tunnelStatus(input: Partial<TunnelStatus>): TunnelStatus {
  return {
    running: true,
    status: 'healthy',
    url: 'https://demo.trycloudflare.com',
    startedAt: '2026-06-02T00:00:00.000Z',
    targetPort: 12580,
    generation: 1,
    lastCheckedAt: '2026-06-02T00:00:10.000Z',
    lastHealthyAt: '2026-06-02T00:00:10.000Z',
    lastRemoteError: null,
    lastLocalError: null,
    lastExitAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    lastProcessOutput: null,
    consecutiveRemoteFailures: 0,
    consecutiveLocalFailures: 0,
    canRegenerate: true,
    ...input,
  }
}

describe('getTunnelAlertDiagnostics', () => {
  it('does not treat normal cloudflared startup stderr as an alert', () => {
    const diagnostics = getTunnelAlertDiagnostics(tunnelStatus({
      status: 'healthy',
      lastProcessOutput: [
        '[stderr] 2026-06-02T09:45:00Z INF Thank you for trying Cloudflare Tunnel.',
        'Doing so, without a Cloudflare account, is a quick way to experiment and try it out.',
      ].join('\n'),
    }))

    expect(diagnostics).toBe('')
  })

  it('keeps cloudflared output visible for process exits and startup errors', () => {
    const diagnostics = getTunnelAlertDiagnostics(tunnelStatus({
      status: 'exited',
      running: false,
      url: null,
      lastError: 'cloudflared exited with code 1',
      lastExitCode: 1,
      lastProcessOutput: '[stderr] cloudflared: no such file or directory',
    }))

    expect(diagnostics).toContain('cloudflared exited with code 1')
    expect(diagnostics).toContain('cloudflared: no such file or directory')
  })
})
