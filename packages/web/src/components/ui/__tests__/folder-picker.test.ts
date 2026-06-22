import { describe, expect, it } from 'vitest'
import { getDirectoryClickAction } from '../folder-picker-utils'

describe('FolderPicker directory click behavior', () => {
  it('selects Git repositories before browsing into them', () => {
    expect(getDirectoryClickAction({ isGitRepo: true })).toBe('select-and-browse')
  })

  it('browses non-Git directories without selecting them', () => {
    expect(getDirectoryClickAction({ isGitRepo: false })).toBe('browse')
  })

  it('selects non-Git directories in directory mode before browsing into them', () => {
    expect(getDirectoryClickAction({ isGitRepo: false }, 'directory')).toBe('select-and-browse')
  })
})
