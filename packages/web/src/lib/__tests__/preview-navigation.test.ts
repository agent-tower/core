import { describe, expect, it } from 'vitest'
import {
  buildPreviewProxyUrl,
  isServerReachablePreviewUrl,
  previewLocationToTarget,
  resolvePreviewNavigation,
  type PreviewEntry,
} from '../preview-navigation'

const sameOrigin: PreviewEntry = { kind: 'same-origin', viewUrl: '/view/workspace-1/' }
const gateway: PreviewEntry = {
  kind: 'gateway',
  viewUrl: 'http://tower.local:41000/?__agent_tower_preview_token=secret',
}

describe('preview navigation', () => {
  it('keeps paths on the current target inside the workspace proxy', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:5173/app/settings?tab=team#members',
      'http://127.0.0.1:5173/app',
      sameOrigin,
    )).toEqual({
      kind: 'proxy',
      url: '/view/workspace-1/settings?tab=team#members',
    })
  })

  it('switches the configured target for a different endpoint', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:3000/dashboard',
      'http://127.0.0.1:5173',
      sameOrigin,
    )).toEqual({
      kind: 'target',
      target: 'http://localhost:3000',
      path: '/dashboard',
    })
    expect(resolvePreviewNavigation(
      'http://192.168.1.20:8080/admin',
      'http://127.0.0.1:5173',
      sameOrigin,
    )).toEqual({
      kind: 'target',
      target: 'http://192.168.1.20:8080',
      path: '/admin',
    })
  })

  it('accepts relative paths and shorthand ports', () => {
    expect(resolvePreviewNavigation('/settings', 'http://127.0.0.1:5173', sameOrigin))
      .toEqual({ kind: 'proxy', url: '/view/workspace-1/settings' })
    expect(resolvePreviewNavigation('3000', null, null))
      .toEqual({ kind: 'target', target: 'http://127.0.0.1:3000', path: '/' })
  })

  it('keeps the requested page separate when switching endpoints', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:41732/other?from=link#result',
      'http://127.0.0.1:41731',
      sameOrigin,
    )).toEqual({
      kind: 'target',
      target: 'http://localhost:41732',
      path: '/other?from=link#result',
    })
  })

  it('builds same-origin proxy URLs under the workspace prefix', () => {
    expect(buildPreviewProxyUrl(sameOrigin, '/login?next=%2Fdashboard#form'))
      .toBe('/view/workspace-1/login?next=%2Fdashboard#form')
    expect(buildPreviewProxyUrl({ kind: 'same-origin', viewUrl: 'https://tower.example.com/view/workspace-1/' }, 'api'))
      .toBe('https://tower.example.com/view/workspace-1/api')
  })

  it('keeps gateway bootstrap credentials while navigating from the preview root', () => {
    expect(buildPreviewProxyUrl(gateway, '/login?next=%2Fdashboard#form'))
      .toBe('http://tower.local:41000/login?next=%2Fdashboard&__agent_tower_preview_token=secret#form')
  })

  it('maps bridge-reported paths back to the target shown in the address bar', () => {
    expect(previewLocationToTarget('http://127.0.0.1:5173/app', '/settings?tab=team#members'))
      .toBe('http://127.0.0.1:5173/app/settings?tab=team#members')
    expect(previewLocationToTarget('http://127.0.0.1:3000', '/'))
      .toBe('http://127.0.0.1:3000/')
    expect(previewLocationToTarget(null, '/')).toBeNull()
  })

  it('recognizes addresses that only the Agent Tower server can reach', () => {
    expect(isServerReachablePreviewUrl('localhost:5173')).toBe(true)
    expect(isServerReachablePreviewUrl('http://0.0.0.0:3000')).toBe(true)
    expect(isServerReachablePreviewUrl('http://192.168.1.20:8080')).toBe(true)
    expect(isServerReachablePreviewUrl('http://10.0.0.5')).toBe(true)
    expect(isServerReachablePreviewUrl('http://api:4000/health')).toBe(true)
    expect(isServerReachablePreviewUrl('http://devbox.local:3000')).toBe(true)
    expect(isServerReachablePreviewUrl('https://example.com')).toBe(false)
    expect(isServerReachablePreviewUrl('https://8.8.8.8')).toBe(false)
    expect(isServerReachablePreviewUrl('mailto:someone@example.com')).toBe(false)
  })
})
