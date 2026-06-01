import { describe, expect, it } from 'vitest'
import {
  filterModelNamesForFormat,
  filterModelsForFormat,
  normalizeModelList,
  splitGroupModelsByFormat,
} from '../../src/utils/modelFormat'

describe('model format helpers', () => {
  it('drops auto models and de-duplicates names', () => {
    const models = normalizeModelList([
      { name: 'auto', apiType: 'both' },
      { name: 'auto', apiType: 'chat' },
      { name: 'gpt-4.1', apiType: 'both' },
      { name: 'gpt-4.1', apiType: 'chat' },
    ], 'both', 'openai')

    expect(models.map(m => m.name)).toEqual(['gpt-4.1'])
  })

  it('separates OpenAI and Anthropic models by format', () => {
    const mixed = normalizeModelList([
      { name: 'gpt-4.1', apiType: 'both' },
      { name: 'claude-3-5-sonnet-20241022', apiType: 'chat' },
    ], 'both', 'openai')

    expect(filterModelsForFormat(mixed, 'openai').map(m => m.name)).toEqual(['gpt-4.1'])
    expect(filterModelsForFormat(mixed, 'anthropic').map(m => m.name)).toEqual(['claude-3-5-sonnet-20241022'])
  })

  it('filters synced model names for the target provider format', () => {
    const names = ['auto', 'auto', 'claude-3-5-sonnet-20241022', 'gpt-4.1', 'gpt-4.1']

    expect(filterModelNamesForFormat(names, 'openai')).toEqual(['gpt-4.1'])
    expect(filterModelNamesForFormat(names, 'anthropic')).toEqual(['claude-3-5-sonnet-20241022'])
  })

  it('splits legacy mixed groupModels into independent format groups', () => {
    const split = splitGroupModelsByFormat({
      default: [
        { name: 'auto', apiType: 'both' },
        { name: 'gpt-4.1', apiType: 'both' },
        { name: 'claude-3-5-sonnet-20241022', apiType: 'chat' },
      ],
    }, 'openai', 'both')

    expect(split.openai.default.map(m => m.name)).toEqual(['gpt-4.1'])
    expect(split.anthropic.default.map(m => m.name)).toEqual(['claude-3-5-sonnet-20241022'])
  })
})
