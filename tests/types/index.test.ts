import { describe, it, expect } from 'vitest'
import type { Provider, StorageData, ExportData, TestStatus } from '../../src/types'

describe('Type Definitions', () => {
  it('should create a valid Provider object', () => {
    const provider: Provider = {
      id: 'test-id',
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(provider.id).toBe('test-id')
    expect(provider.isActive).toBe(true)
  })

  it('should create a valid Provider with TestStatus', () => {
    const testStatus: TestStatus = {
      lastTestTime: Date.now(),
      isSuccess: true,
    }
    const provider: Provider = {
      id: 'test-id',
      name: 'Test Provider',
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: true,
      testStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(provider.testStatus?.isSuccess).toBe(true)
  })

  it('should create a valid StorageData object', () => {
    const storageData: StorageData = {
      providers: [],
      activeProviderId: null,
    }
    expect(storageData.providers).toEqual([])
    expect(storageData.activeProviderId).toBeNull()
  })

  it('should create a valid ExportData object', () => {
    const exportData: ExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providers: [
        {
          name: 'Test',
          baseUrl: 'https://api.test.com',
          apiKey: 'test-key',
          model: 'gpt-3.5-turbo',
          models: ['gpt-3.5-turbo'],
        },
      ],
    }
    expect(exportData.version).toBe('1.0')
    expect(exportData.providers).toHaveLength(1)
  })
})
