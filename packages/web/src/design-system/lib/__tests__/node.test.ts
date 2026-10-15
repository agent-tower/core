import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { hasNode } from '../node'

describe('hasNode', () => {
  it('treats 0 and real content as content', () => {
    expect(hasNode(0)).toBe(true)
    expect(hasNode('34')).toBe(true)
    expect(hasNode(createElement('span'))).toBe(true)
  })

  it('treats empty slots as empty', () => {
    expect(hasNode(null)).toBe(false)
    expect(hasNode(undefined)).toBe(false)
    expect(hasNode(false)).toBe(false)
    expect(hasNode(true)).toBe(false)
    expect(hasNode('')).toBe(false)
  })
})
