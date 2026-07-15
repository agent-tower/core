import { describe, expect, it } from 'vitest'
import { localImageUrl, resolveMessageResource, workspaceImageUrl } from '@/lib/message-resource'

describe('resolveMessageResource', () => {
  const workingDir = '/Users/example/project'

  it('keeps web and application URLs as links', () => {
    expect(resolveMessageResource('https://example.com/file.png', workingDir)).toEqual({
      type: 'external',
      url: 'https://example.com/file.png',
    })
    expect(resolveMessageResource('http://localhost:12580/tasks/123', workingDir)).toEqual({
      type: 'external',
      url: 'http://localhost:12580/tasks/123',
    })
    expect(resolveMessageResource('/tasks/123', workingDir)).toEqual({
      type: 'internal',
      url: '/tasks/123',
    })
    expect(resolveMessageResource('/api/files/read', workingDir)).toEqual({
      type: 'internal',
      url: '/api/files/read',
    })
  })

  it('recognizes absolute and relative workspace files', () => {
    expect(resolveMessageResource('/Users/example/project/src/app.tsx', workingDir)).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
    })
    expect(resolveMessageResource('./src/app.tsx', workingDir)).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
    })
  })

  it('separates line and column locations from workspace file paths', () => {
    expect(resolveMessageResource('/Users/example/project/src/app.tsx:87', workingDir)).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
      line: 87,
      column: undefined,
    })
    expect(resolveMessageResource('./src/app.tsx:87:12', workingDir)).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
      line: 87,
      column: 12,
    })
    expect(resolveMessageResource('src/app.tsx#L87C12', workingDir)).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
      line: 87,
      column: 12,
    })
    expect(resolveMessageResource('C:\\project\\src\\app.tsx:87', 'C:\\project')).toEqual({
      type: 'workspace-file',
      path: 'src/app.tsx',
      line: 87,
      column: undefined,
    })
  })

  it('only maps known attachment paths to the attachment endpoint', () => {
    const resource = resolveMessageResource('/Users/example/.agent-tower/data/attachments/ab/image.png', workingDir)
    expect(resource.type).toBe('attachment')
    expect(resource).toMatchObject({ path: '/Users/example/.agent-tower/data/attachments/ab/image.png' })
    expect(resource.type === 'attachment' && resource.url).toContain('/attachments/by-path?path=')

    expect(resolveMessageResource('/Users/example/.agent-tower/conversations/thread/result.png', workingDir).type).toBe('attachment')

    expect(resolveMessageResource('/Users/example/elsewhere/image.png', workingDir)).toEqual({
      type: 'unknown-local',
      path: '/Users/example/elsewhere/image.png',
    })
  })

  it('builds workspace image URLs using the guarded files endpoint', () => {
    const url = workspaceImageUrl(workingDir, 'screenshots/result image.png')
    expect(url).toContain('/files/image?')
    expect(url).toContain('workingDir=%2FUsers%2Fexample%2Fproject')
    expect(url).toContain('path=screenshots%2Fresult+image.png')
  })

  it('builds local image URLs for absolute filesystem paths', () => {
    const url = localImageUrl('/Users/example/elsewhere/result image.png')
    expect(url).toContain('/files/image?')
    expect(url).toContain('path=%2FUsers%2Fexample%2Felsewhere%2Fresult+image.png')
    expect(url).not.toContain('workingDir=')
  })
})
