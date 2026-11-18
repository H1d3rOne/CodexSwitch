import { describe, expect, it } from 'vitest'
import type { ApiType, Provider, ProviderFormat } from '../../src/types'
import { projectRouterProvider } from '../../src/utils/routerProvider'

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  const format = overrides.format || 'openai'
  const apiType = overrides.apiType || 'chat'
  const model = format === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'
  const models = [{ name: model, apiType, format }]
  return {
    id: 'source',
    name: 'Source Provider',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    groupApiKeys: { default: 'sk-test' },
    groupModels: { default: models },
    activeGroup: 'default',
    model,
    models,
    apiType,
    format,
    formatConversionEnabled: true,
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Router provider projection', () => {
  it.each<ApiType>(['chat', 'responses', 'both'])('projects OpenAI %s models to Anthropic Messages', apiType => {
    const source = makeProvider({ apiType })
    const projected = projectRouterProvider(source, 'anthropic')

    expect(projected).toMatchObject({ format: 'anthropic', apiType: 'messages' })
    expect(projected.models).toEqual([{ name: 'gpt-4.1', format: 'anthropic', apiType: 'messages' }])
    expect(projected.groupModels.default).toEqual(projected.models)
    expect(projected.formatModels).toEqual({ anthropic: projected.models })
    expect(projected.formatGroupModels).toEqual({ anthropic: { default: projected.models } })
  })

  it.each<ApiType>(['chat', 'responses', 'both'])('projects Anthropic %s models to both OpenAI interfaces', apiType => {
    const source = makeProvider({ format: 'anthropic', apiType })
    const projected = projectRouterProvider(source, 'openai')

    expect(projected).toMatchObject({ format: 'openai', apiType: 'both' })
    expect(projected.models).toEqual([{ name: 'claude-sonnet-4-5', format: 'openai', apiType: 'both' }])
    expect(projected.groupModels.default).toEqual(projected.models)
    expect(projected.formatModels).toEqual({ openai: projected.models })
    expect(projected.formatGroupModels).toEqual({ openai: { default: projected.models } })
  })

  it.each<ProviderFormat>(['openai', 'anthropic', 'deepseek'])('leaves the native %s provider and its model types unchanged', format => {
    const source = makeProvider({ format, apiType: 'responses' })

    expect(projectRouterProvider(source, format)).toBe(source)
    expect(source.apiType).toBe('responses')
    expect(source.models[0].apiType).toBe('responses')
  })

  it.each<ProviderFormat>(['openai', 'anthropic', 'deepseek'])('keeps %s source identity without mutating nested models', format => {
    const source = makeProvider({ format })
    source.formatModels = { [format]: source.models }
    source.formatGroupModels = { [format]: source.groupModels }
    const original = structuredClone(source)
    const targetFormat = format === 'anthropic' ? 'openai' : 'anthropic'
    const projected = projectRouterProvider(source, targetFormat)

    expect(projected).not.toBe(source)
    expect(projected).toMatchObject({
      id: source.id,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      model: source.model,
      activeGroup: source.activeGroup,
      formatConversionEnabled: true,
    })
    expect(projected.models).not.toBe(source.models)
    expect(projected.models[0]).not.toBe(source.models[0])
    expect(projected.groupModels).not.toBe(source.groupModels)
    expect(projected.groupModels.default[0]).not.toBe(source.groupModels.default[0])
    expect(projected.formatModels?.[targetFormat]?.[0]).not.toBe(source.formatModels[format]?.[0])
    expect(projected.formatGroupModels?.[targetFormat]?.default[0]).not.toBe(source.formatGroupModels[format]?.default[0])
    expect(source).toEqual(original)
  })

  it('projects all source groups and only source-format buckets', () => {
    const primary = { name: 'gpt-4.1', apiType: 'chat' as const, format: 'openai' as const }
    const team = { name: 'gpt-4.1-mini', apiType: 'responses' as const, format: 'openai' as const }
    const unused = { name: 'claude-sonnet-4-5', apiType: 'chat' as const, format: 'anthropic' as const }
    const source = makeProvider({
      models: [primary, team],
      groupApiKeys: { default: 'sk-test', team: 'sk-team' },
      groupModels: { default: [primary], team: [team] },
      formatModels: { openai: [team], anthropic: [unused] },
      formatGroupModels: { openai: { default: [primary], team: [team] }, anthropic: { default: [unused] } },
      activeGroup: 'team',
      model: team.name,
    })
    const projected = projectRouterProvider(source, 'anthropic')

    expect(projected.models).toEqual([
      { name: primary.name, format: 'anthropic', apiType: 'messages' },
      { name: team.name, format: 'anthropic', apiType: 'messages' },
    ])
    expect(projected.groupModels).toEqual({
      default: [projected.models[0]],
      team: [projected.models[1]],
    })
    expect(projected.formatModels).toEqual({ anthropic: [projected.models[1]] })
    expect(projected.formatGroupModels).toEqual({ anthropic: projected.groupModels })
    expect(projected.groupApiKeys).toEqual(source.groupApiKeys)
    expect(projected.activeGroup).toBe('team')
    expect(projected.model).toBe(team.name)
  })

  it.each([
    { sourceFormat: 'openai', targetFormat: 'anthropic', model: 'gpt-4.1', apiType: 'messages' },
    { sourceFormat: 'anthropic', targetFormat: 'openai', model: 'claude-sonnet-4-5', apiType: 'both' },
  ] as const)('overrides name-inferred formats for $targetFormat models', testCase => {
    const source = makeProvider({
      format: testCase.sourceFormat,
      model: testCase.model,
      models: [{ name: testCase.model, apiType: 'chat' }],
      groupModels: { default: [{ name: testCase.model, apiType: 'chat' }] },
    })
    const projected = projectRouterProvider(source, testCase.targetFormat)

    expect(projected.models).toEqual([{ name: testCase.model, apiType: testCase.apiType, format: testCase.targetFormat }])
    expect(projected.groupModels.default).toEqual(projected.models)
  })

  it('uses legacy OpenAI defaults and the selected model when model lists are missing', () => {
    const source = makeProvider({ format: undefined, models: undefined, groupModels: undefined, activeGroup: 'team' })
    const projected = projectRouterProvider(source, 'anthropic')

    expect(projectRouterProvider(source, 'openai')).toBe(source)
    expect(projected.models).toEqual([{ name: 'gpt-4.1', format: 'anthropic', apiType: 'messages' }])
    expect(projected.groupModels).toEqual({ team: projected.models })
    expect(projected.formatGroupModels).toEqual({ anthropic: { team: projected.models } })
  })

  it('uses source-format groups when legacy groupModels are missing', () => {
    const source = makeProvider({
      groupModels: undefined,
      formatGroupModels: {
        openai: { default: [{ name: 'gpt-4.1-mini', apiType: 'responses', format: 'openai' }] },
        anthropic: { default: [{ name: 'claude-sonnet-4-5', apiType: 'messages', format: 'anthropic' }] },
      },
    })
    const projected = projectRouterProvider(source, 'anthropic')

    expect(projected.groupModels).toEqual({ default: [{ name: 'gpt-4.1-mini', apiType: 'messages', format: 'anthropic' }] })
    expect(projected.formatGroupModels).toEqual({ anthropic: projected.groupModels })
  })

  it('drops auto and duplicate model entries without losing names during conversion', () => {
    const source = makeProvider({
      models: [
        { name: 'auto', apiType: 'chat' },
        { name: ' gpt-4.1 ', apiType: 'chat' },
        { name: 'gpt-4.1', apiType: 'responses' },
      ],
    })

    expect(projectRouterProvider(source, 'anthropic').models).toEqual([
      { name: 'gpt-4.1', apiType: 'messages', format: 'anthropic' },
    ])
  })
})
