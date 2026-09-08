import { describe, expect, it } from 'vitest'
import { parseCodexModelCatalog } from '../codex-model-capabilities.service.js'

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
})
