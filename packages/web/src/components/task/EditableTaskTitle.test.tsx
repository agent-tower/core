import { describe, it, expect } from 'vitest'

describe('EditableTaskTitle', () => {
  it('组件应该可以正常导入', async () => {
    const module = await import('./EditableTaskTitle')
    expect(module.EditableTaskTitle).toBeDefined()
  })
})
