import { afterEach, describe, expect, it } from 'vitest'
import {
  getCodexReasoningEffortOptions,
  parseCodexModelCatalog,
  resetCodexModelCatalogForTests,
} from '../codex-model-capabilities.service.js'

const originalCodexPath = process.env.CODEX_PATH

afterEach(() => {
  if (originalCodexPath === undefined) delete process.env.CODEX_PATH
  else process.env.CODEX_PATH = originalCodexPath
  resetCodexModelCatalogForTests()
})

describe('Codex model capabilities', () => {
  it('parses model-specific reasoning levels from the CLI catalog', () => {
    const catalog = parseCodexModelCatalog([
      'notice: catalog loaded',
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6-astra',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'xhigh' },
              { effort: 'max' },
              { effort: 'ultra' },
            ],
          },
          {
            slug: 'gpt-5.4',
            supported_reasoning_levels: [{ effort: 'high' }],
          },
        ],
      }),
    ].join('\n'))

    expect(catalog.get('gpt-6-astra')).toEqual(['low', 'xhigh', 'max', 'ultra'])
    expect(catalog.get('gpt-5.4')).toEqual(['high'])
  })

  it('rejects output that does not contain a JSON catalog', () => {
    expect(() => parseCodexModelCatalog('codex unavailable')).toThrow('not JSON')
  })

  it('keeps the documented ceilings when the installed CLI catalog is unavailable', async () => {
    process.env.CODEX_PATH = '/nonexistent/agent-tower-codex-model-catalog'
    resetCodexModelCatalogForTests()

    expect((await getCodexReasoningEffortOptions('gpt-6-sol')).options).toEqual([
      'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect((await getCodexReasoningEffortOptions('gpt-6-luna')).options).toEqual([
      'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect((await getCodexReasoningEffortOptions('custom-model')).options).toEqual([
      'minimal', 'low', 'medium', 'high', 'xhigh',
    ])
  })
})
