import type { Provider, ExportData } from '../types'

export function exportProviders(providers: Provider[]): ExportData {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    providers: providers.map(p => ({
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
    })),
  }
}

export function validateExportData(data: unknown): {
  valid: boolean
  errors?: string[]
} {
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Data must be an object'] }
  }

  const obj = data as Record<string, unknown>

  if (obj.version !== '1.0') {
    return { valid: false, errors: ['Invalid or missing version'] }
  }

  if (!Array.isArray(obj.providers)) {
    return { valid: false, errors: ['Providers must be an array'] }
  }

  const errors: string[] = []
  obj.providers.forEach((provider, index) => {
    if (!provider || typeof provider !== 'object') {
      errors.push(`Provider ${index} must be an object`)
      return
    }
    if (!provider.name || typeof provider.name !== 'string') {
      errors.push(`Provider ${index} missing name`)
    }
    if (!provider.baseUrl || typeof provider.baseUrl !== 'string') {
      errors.push(`Provider ${index} missing baseUrl`)
    }
    if (!provider.apiKey || typeof provider.apiKey !== 'string') {
      errors.push(`Provider ${index} missing apiKey`)
    }
  })

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  return { valid: true }
}

export function importProviders(data: ExportData): Array<Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>> {
  return data.providers.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model || 'gpt-3.5-turbo',
    isActive: false,
  }))
}

export function downloadJSON(data: ExportData, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function readJSONFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string)
        resolve(data)
      } catch (error) {
        reject(new Error('Invalid JSON file'))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
