import { describe, it, expect } from 'vitest'
import { exportProviders, importProviders, validateExportData } from '../../src/utils/export'
import type { Provider, ExportData } from '../../src/types'

describe('Export Utility', () => {
  const mockProviders: Provider[] = [
    {
      id: 'test-1',
      name: 'Provider 1',
      baseUrl: 'https://api.test1.com',
      apiKey: 'key1',
      model: 'gpt-3.5-turbo',
      models: ['gpt-3.5-turbo'],
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: 'test-2',
      name: 'Provider 2',
      baseUrl: 'https://api.test2.com',
      apiKey: 'key2',
      model: 'gpt-4',
      models: ['gpt-4'],
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]

  it('should export providers to correct format', () => {
    const exported = exportProviders(mockProviders)
    expect(exported.version).toBe('1.0')
    expect(exported.exportedAt).toBeDefined()
    expect(exported.providers).toHaveLength(2)
    expect(exported.providers[0].name).toBe('Provider 1')
    expect(exported.providers[0]).not.toHaveProperty('id')
    expect(exported.providers[0]).not.toHaveProperty('isActive')
  })

  it('should validate correct export data', () => {
    const data: ExportData = {
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
    const result = validateExportData(data)
    expect(result.valid).toBe(true)
  })

  it('should reject invalid export data', () => {
    const data = {
      version: '1.0',
      providers: [
        {
          name: 'Test',
        },
      ],
    }
    const result = validateExportData(data)
    expect(result.valid).toBe(false)
    expect(result.errors).toBeDefined()
  })

  it('should import providers correctly', () => {
    const data: ExportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providers: [
        {
          name: 'Imported Provider',
          baseUrl: 'https://api.imported.com',
          apiKey: 'imported-key',
          model: 'gpt-4',
          models: ['gpt-4'],
        },
      ],
    }
    const imported = importProviders(data)
    expect(imported).toHaveLength(1)
    expect(imported[0].name).toBe('Imported Provider')
    expect(imported[0].isActive).toBe(false)
  })

  it('should reject data with wrong version', () => {
    const data = {
      version: '2.0',
      providers: [],
    }
    const result = validateExportData(data)
    expect(result.valid).toBe(false)
  })

  it('should reject non-object data', () => {
    const result = validateExportData(null)
    expect(result.valid).toBe(false)
  })
})
