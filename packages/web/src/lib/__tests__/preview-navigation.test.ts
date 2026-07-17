import { describe, expect, it } from 'vitest'
import {
  buildPreviewProxyUrl,
  isLoopbackPreviewUrl,
  previewLocationToTarget,
  resolvePreviewNavigation,
} from '../preview-navigation'

describe('preview navigation', () => {
  it('keeps paths on the current target inside the workspace proxy', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:5173/app/settings?tab=team#members',
      'http://127.0.0.1:5173/app',
      '/view/workspace-1/',
    )).toEqual({
      kind: 'proxy',
      url: '/view/workspace-1/settings?tab=team#members',
    })
  })

  it('switches the configured target for a different local port', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:3000/dashboard',
      'http://127.0.0.1:5173',
      '/view/workspace-1/',
    )).toEqual({
      kind: 'target',
      target: 'http://localhost:3000',
      path: '/dashboard',
    })
  })

  it('accepts relative paths and shorthand ports', () => {
    expect(resolvePreviewNavigation('/settings', 'http://127.0.0.1:5173', '/view/workspace-1/'))
      .toEqual({ kind: 'proxy', url: '/view/workspace-1/settings' })
    expect(resolvePreviewNavigation('3000', null, null))
      .toEqual({ kind: 'target', target: 'http://127.0.0.1:3000', path: '/' })
  })

  it('keeps the requested page separate when switching local endpoints', () => {
    expect(resolvePreviewNavigation(
      'http://localhost:41732/other?from=link#result',
      'http://127.0.0.1:41731',
      '/view/workspace-1/',
    )).toEqual({
      kind: 'target',
      target: 'http://localhost:41732',
      path: '/other?from=link#result',
    })
  })

  it('maps proxy locations back to the local target shown in the address bar', () => {
    expect(previewLocationToTarget(
      'http://127.0.0.1:5173/app',
      '/view/workspace-1/',
      'https://tower.example.com/view/workspace-1/settings?tab=team#members',
      'https://tower.example.com/tasks/1',
    )).toBe('http://127.0.0.1:5173/app/settings?tab=team#members')
  })

  it('keeps gateway bootstrap credentials while navigating from the preview root', () => {
    const viewUrl = 'https://preview.example.com/?__agent_tower_preview_token=secret'

    expect(buildPreviewProxyUrl(viewUrl, '/login?next=%2Fdashboard#form'))
      .toBe('https://preview.example.com/login?next=%2Fdashboard&__agent_tower_preview_token=secret#form')
  })

  it('maps independent preview origins back to the local target', () => {
    expect(previewLocationToTarget(
      'http://127.0.0.1:3000/app',
      'https://preview.example.com/?__agent_tower_preview_token=secret',
      'https://preview.example.com/login?next=%2Fdashboard',
      'https://tower.example.com/tasks/1',
    )).toBe('http://127.0.0.1:3000/app/login?next=%2Fdashboard')
  })

  it('recognizes supported local addresses', () => {
    expect(isLoopbackPreviewUrl('localhost:5173')).toBe(true)
    expect(isLoopbackPreviewUrl('http://0.0.0.0:3000')).toBe(true)
    expect(isLoopbackPreviewUrl('https://example.com')).toBe(false)
    expect(buildPreviewProxyUrl('/view/workspace-1', '/api')).toBe('/view/workspace-1/api')
  })
})
