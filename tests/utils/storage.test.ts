import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProvider,
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

  it('should add a provider', async () => {
    const provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'> = {
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
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
      isActive: false,
    })
    const updated = await updateProvider(provider.id, { name: 'Updated' })
    expect(updated?.name).toBe('Updated')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(provider.updatedAt)
  })

  it('should delete a provider', async () => {
    const provider = await addProvider({
      name: 'Test',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
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
      isActive: false,
    })
    const provider2 = await addProvider({
      name: 'Provider 2',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      isActive: false,
    })
    await setActiveProvider(provider1.id)
    const active = await getActiveProvider()
    expect(active?.id).toBe(provider1.id)

    await setActiveProvider(provider2.id)
    const newActive = await getActiveProvider()
    expect(newActive?.id).toBe(provider2.id)
  })
})
