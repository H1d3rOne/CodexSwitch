import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  setRouterActiveProvider,
  setRouterEffectiveProvider,
  getActiveProvider,
  getSites,
  updateSite,
} from '../../src/utils/storage'
import type { Provider } from '../../src/types'

const mockStorage: { [key: string]: unknown } = {}

global.chrome = {
  storage: {
    local: {
      get: vi.fn((keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys]
        const result: { [key: string]: unknown } = {}
        keyList.forEach(key => {
          if (mockStorage[key] !== undefined) {
            result[key] = mockStorage[key]
          }
        })
        return Promise.resolve(result)
      }),
      set: vi.fn((items: { [key: string]: unknown }) => {
        Object.assign(mockStorage, items)
        return Promise.resolve()
      }),
    },
  },
} as unknown as typeof chrome

describe('Storage Utility', () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach(key => delete mockStorage[key])
  })

  it('should return empty providers list initially', async () => {
    const providers = await getProviders()
    expect(providers).toEqual([])
  })

  it('preserves independent routes when provider metadata and sites are saved concurrently', async () => {
    mockStorage.codex_switch_data = {
      providers: [
        { id: 'o', format: 'openai', isActive: true, routerEffectiveFormats: ['openai'] },
        { id: 'a', format: 'anthropic', isActive: true, routerEffectiveFormats: ['anthropic'] },
        { id: 'd', format: 'deepseek', isActive: true, routerEffectiveFormats: ['deepseek'] },
      ],
      sites: [{ id: 's', balance: '0' }],
      activeProviderId: 'o',
    }
    await Promise.all([
      setRouterEffectiveProvider('a', 'openai'),
      setRouterEffectiveProvider('o', 'anthropic'),
      updateProvider('d', { balance: '42' }),
      updateSite('s', { balance: '42' }),
    ])
    const after = await getProviders()
    expect(after.find(provider => provider.id === 'o')?.routerEffectiveFormats).toEqual(['anthropic'])
    expect(after.find(provider => provider.id === 'a')?.routerEffectiveFormats).toEqual(['openai'])
    expect(after.find(provider => provider.id === 'd')).toMatchObject({ balance: '42', routerEffectiveFormats: ['deepseek'] })
    expect(after.map(provider => provider.isActive)).toEqual([true, true, true])
    expect((await getSites())[0].balance).toBe('42')
  })

  it('continues storage mutations after a route save fails', async () => {
    mockStorage.codex_switch_data = { providers: [
      { id: 'o', format: 'openai', isActive: true },
      { id: 'a', format: 'anthropic', isActive: true },
    ] }
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('Storage unavailable'))
    const results = await Promise.allSettled([
      setRouterEffectiveProvider('a', 'openai'),
      setRouterEffectiveProvider('o', 'anthropic'),
    ])
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('Storage unavailable') })
    expect(results[1].status).toBe('fulfilled')
    const after = await getProviders()
    expect(after[0]).toMatchObject({ isActive: true, routerEffectiveFormats: ['anthropic'] })
    expect(after[1].routerEffectiveFormats).toBeUndefined()
  })

  it.each([
    ['o', 'anthropic'],
    ['a', 'openai'],
    ['d', 'deepseek'],
  ] as const)('keeps native selections and other routes when %s serves %s', async (id, targetFormat) => {
    mockStorage.codex_switch_data = { providers: [
      { id: 'o', format: 'openai', isActive: true, routerEffectiveFormats: ['openai'], routerActiveFormats: ['anthropic'] },
      { id: 'a', format: 'anthropic', isActive: true, routerEffectiveFormats: ['anthropic'], routerActiveFormats: ['openai'] },
      { id: 'd', format: 'deepseek', isActive: true, routerEffectiveFormats: ['deepseek'] },
    ], activeProviderId: 'o' }
    const before = await getProviders()
    await setRouterEffectiveProvider(id, targetFormat)
    const after = await getProviders()

    expect(after.map(provider => provider.isActive)).toEqual([true, true, true])
    expect(after.filter(provider => provider.routerEffectiveFormats?.includes(targetFormat)).map(provider => provider.id)).toEqual([id])
    for (const [index, provider] of after.entries()) {
      expect(provider.routerActiveFormats).toEqual(before[index].routerActiveFormats)
      expect(provider.routerEffectiveFormats?.filter(format => format !== targetFormat)).toEqual(before[index].routerEffectiveFormats?.filter(format => format !== targetFormat))
    }
    expect((await getActiveProvider())?.id).toBe('o')
  })

  it('should add a provider', async () => {
    const provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'> = {
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: false,
    }
    const result = await addProvider(provider)
    expect(result.name).toBe('Test Provider')
    expect(result.id).toBeDefined()
    expect(result.createdAt).toBeDefined()
    expect(result.updatedAt).toBeDefined()
  })

  it('should update a provider', async () => {
    const provider = await addProvider({
      name: 'Test',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: false,
    })
    const updated = await updateProvider(provider.id, { name: 'Updated' })
    expect(updated?.name).toBe('Updated')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(provider.updatedAt)
  })

  it('defaults format conversion to off for legacy providers', async () => {
    await addProvider({
      name: 'Legacy',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-4',
      models: ['gpt-4'],
      isActive: false,
    })

    const [provider] = await getProviders()
    expect(provider.formatConversionEnabled).toBe(false)
  })

  it.each([true, false])('persists format conversion set to %s', async formatConversionEnabled => {
    const provider = await addProvider({
      name: 'Conversion',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-4',
      models: ['gpt-4'],
      formatConversionEnabled,
      isActive: false,
    })

    expect((await getProviders())[0].formatConversionEnabled).toBe(formatConversionEnabled)
    await updateProvider(provider.id, { formatConversionEnabled: !formatConversionEnabled })
    expect((await getProviders())[0].formatConversionEnabled).toBe(!formatConversionEnabled)
    expect((mockStorage.codex_switch_data as { providers: Provider[] }).providers[0].formatConversionEnabled).toBe(!formatConversionEnabled)
  })

  it('should delete a provider', async () => {
    const provider = await addProvider({
      name: 'Test',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: false,
    })
    await deleteProvider(provider.id)
    const providers = await getProviders()
    expect(providers).toHaveLength(0)
  })

  it('should set active provider', async () => {
    const provider1 = await addProvider({
      name: 'Provider 1',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: false,
    })
    const provider2 = await addProvider({
      name: 'Provider 2',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: false,
    })
    await setActiveProvider(provider1.id)
    const active = await getActiveProvider()
    expect(active?.id).toBe(provider1.id)

    await setActiveProvider(provider2.id)
    const newActive = await getActiveProvider()
    expect(newActive?.id).toBe(provider2.id)
  })

  it('should return empty sites list for legacy storage data without sites field', async () => {
    mockStorage.codex_switch_data = {
      providers: [],
      activeProviderId: null,
    }

    const sites = await getSites()
    expect(sites).toEqual([])
  })

  it('should drop auto models and keep OpenAI/Anthropic model lists separated', async () => {
    mockStorage.codex_switch_data = {
      providers: [
        {
          id: 'mixed-provider',
          name: 'Mixed Provider',
          baseUrl: 'https://api.test.com',
          apiKey: 'test-key',
          model: 'auto',
          models: [
            { name: 'auto', apiType: 'both' },
            { name: 'auto', apiType: 'chat' },
            { name: 'gpt-4.1', apiType: 'both' },
            { name: 'claude-3-5-sonnet-20241022', apiType: 'chat' },
          ],
          groupModels: {
            default: [
              { name: 'auto', apiType: 'both' },
              { name: 'gpt-4.1', apiType: 'both' },
              { name: 'claude-3-5-sonnet-20241022', apiType: 'chat' },
            ],
          },
          activeGroup: 'default',
          format: 'openai',
          isActive: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeProviderId: null,
      sites: [],
    }

    const [provider] = await getProviders()

    expect(provider.models.map(m => m.name)).toEqual(['gpt-4.1'])
    expect(provider.model).toBe('gpt-4.1')
    expect(provider.groupModels.default.map(m => m.name)).toEqual(['gpt-4.1'])
    expect(provider.formatGroupModels?.anthropic?.default.map(m => m.name)).toEqual(['claude-3-5-sonnet-20241022'])
  })
})

 it('keeps router selections independent from each other and direct activation', async () => {
  mockStorage.codex_switch_data = { providers: [
    { id: 'a', format: 'openai', isActive: true },
    { id: 'b', format: 'anthropic', isActive: false },
  ], activeProviderId: 'a' }
  await setRouterActiveProvider('a', 'anthropic')
  await setRouterActiveProvider('b', 'openai')
  const providers = await getProviders()
  expect(providers[0].routerActiveFormats).toEqual(['anthropic'])
  expect(providers[1].routerActiveFormats).toEqual(['openai'])
  expect(providers[0].isActive).toBe(true)
  expect((await getActiveProvider())?.id).toBe('a')
  await setActiveProvider('b')
  const selected = await getProviders()
  expect(selected.every(provider => provider.isActive)).toBe(true)
  expect(selected.map(provider => provider.routerActiveFormats)).toEqual([['anthropic'], ['openai']])
})

it('replaces only the native selection of the same format', async () => {
  mockStorage.codex_switch_data = { providers: [
    { id: 'o1', format: 'openai', isActive: true, routerActiveFormats: ['anthropic'] },
    { id: 'o2', format: 'openai', isActive: false },
    { id: 'a1', format: 'anthropic', isActive: true },
    { id: 'a2', format: 'anthropic', isActive: false },
  ] }
  await setActiveProvider('o2')
  await setActiveProvider('a2')
  const selected = await getProviders()
  expect(selected.filter(provider => provider.isActive).map(provider => provider.id)).toEqual(['o2', 'a2'])
  expect(selected[0].routerActiveFormats).toEqual(['anthropic'])
})
