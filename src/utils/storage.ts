import type { Provider, ProviderFormat, Site, StorageData } from '../types'
import {
  filterModelsForFormat,
  hasAnyModels,
  normalizeFormatGroupModels,
  normalizeFormatModels,
  normalizeGroupModelsForFormat,
  normalizeModelList,
  splitGroupModelsByFormat,
} from './modelFormat'
import { generateUUID } from './uuid'

const STORAGE_KEY = 'codex_switch_data'
let storageMutationQueue: Promise<void> = Promise.resolve()

function serializeStorageMutation<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  return (...args: Args): Promise<Result> => {
    // Providers and sites share one document. Queue the read as well as the
    // write so background tests/balance updates cannot restore an old route.
    const result = storageMutationQueue.then(() => operation(...args))
    storageMutationQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

async function getStorageData(): Promise<StorageData> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const raw = result[STORAGE_KEY] || {}

  const providers = Array.isArray(raw.providers) ? raw.providers : []
  // Migrate existing providers without format/groupApiKeys fields
  const migratedProviders = providers.map((p: Provider) => {
    const format = p.format || 'openai'
    const activeGroup = p.activeGroup || 'default'
    const fallbackApiType = p.apiType || (
      format === 'anthropic' ? 'chat' : format === 'deepseek' ? 'all' : 'both'
    )
    const groupApiKeys = p.groupApiKeys || { default: p.apiKey || '' }
    const fallbackModels = p.model ? [{ name: p.model, apiType: fallbackApiType, format }] : []
    const topModels = filterModelsForFormat(normalizeModelList(p.models || fallbackModels, fallbackApiType, format), format)
    const sourceGroupModels = p.groupModels || { default: topModels }
    const splitLegacyGroupModels = splitGroupModelsByFormat(sourceGroupModels, format, fallbackApiType)
    const persistedFormatGroupModels = normalizeFormatGroupModels(p.formatGroupModels)
    const groupModels = normalizeGroupModelsForFormat(sourceGroupModels, format, fallbackApiType)
    const formatModels = normalizeFormatModels(p.formatModels)
    const formatGroupModels = Object.fromEntries(
      (['openai', 'anthropic', 'deepseek'] as ProviderFormat[]).map(targetFormat => [
        targetFormat,
        targetFormat === format
          ? groupModels
          : hasAnyModels(persistedFormatGroupModels[targetFormat])
            ? persistedFormatGroupModels[targetFormat]!
            : splitLegacyGroupModels[targetFormat],
      ])
    ) as Provider['formatGroupModels']
    const activeModels = groupModels[activeGroup] || topModels
    const models = activeModels.length > 0 ? activeModels : topModels
    return {
      ...p,
      format,
      formatConversionEnabled: p.formatConversionEnabled === true,
      // Older router selections also stored native entries in this array.
      routerActiveFormats: (p.routerActiveFormats || []).filter(target => target !== format),
      groupApiKeys,
      models,
      model: models.some(m => m.name === p.model) ? p.model : (models[0]?.name || ''),
      groupModels,
      formatModels,
      formatGroupModels,
      activeGroup,
    }
  })

  return {
    providers: migratedProviders,
    activeProviderId: raw.activeProviderId ?? null,
    sites: Array.isArray(raw.sites) ? raw.sites : [],
  }
}

async function setStorageData(data: StorageData): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: data })
}

export async function getProviders(): Promise<Provider[]> {
  const data = await getStorageData()
  return data.providers
}

export const addProvider = serializeStorageMutation(async (
  provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Provider> => {
  const data = await getStorageData()
  const now = Date.now()
  const newProvider: Provider = {
    ...provider,
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
  }
  data.providers.push(newProvider)
  await setStorageData(data)
  return newProvider
})

export const updateProvider = serializeStorageMutation(async (
  id: string,
  updates: Partial<Omit<Provider, 'id' | 'createdAt'>>
): Promise<Provider | null> => {
  const data = await getStorageData()
  const index = data.providers.findIndex(p => p.id === id)
  if (index === -1) return null

  data.providers[index] = {
    ...data.providers[index],
    ...updates,
    updatedAt: Date.now(),
  }
  await setStorageData(data)
  return data.providers[index]
})

export const deleteProvider = serializeStorageMutation(async (id: string): Promise<void> => {
  const data = await getStorageData()
  data.providers = data.providers.filter(p => p.id !== id)
  if (data.activeProviderId === id) {
    data.activeProviderId = null
  }
  await setStorageData(data)
})

function selectRouterFormat(formats: ProviderFormat[] | undefined, targetFormat: ProviderFormat, selected: boolean): ProviderFormat[] | undefined {
  if (!selected && !formats?.includes(targetFormat)) return formats
  return [...(formats || []).filter(format => format !== targetFormat), ...(selected ? [targetFormat] : [])]
}

export const setRouterActiveProvider = serializeStorageMutation(async (id: string, targetFormat: ProviderFormat): Promise<void> => {
  const data = await getStorageData()
  const selected = data.providers.find(provider => provider.id === id)
  if (!selected || (selected.format || 'openai') === targetFormat) return
  data.providers = data.providers.map(provider => ({
    ...provider,
    // Route selection is exclusive per target, never a change to direct selection.
    routerEffectiveFormats: selectRouterFormat(provider.routerEffectiveFormats, targetFormat, provider.id === id),
    routerActiveFormats: selectRouterFormat(provider.routerActiveFormats, targetFormat, provider.id === id),
  }))
  await setStorageData(data)
})

export const setRouterEffectiveProvider = serializeStorageMutation(async (id: string, targetFormat: ProviderFormat): Promise<void> => {
  const data = await getStorageData()
  const selected = data.providers.find(provider => provider.id === id)
  if (!selected) return
  data.providers = data.providers.map(provider => ({
    ...provider,
    // Keep the native provider available for restoring this client's direct config.
    routerEffectiveFormats: selectRouterFormat(provider.routerEffectiveFormats, targetFormat, provider.id === id),
  }))
  await setStorageData(data)
})

export const setActiveProvider = serializeStorageMutation(async (id: string, routed = false): Promise<void> => {
  const data = await getStorageData()
  const selected = data.providers.find(p => p.id === id)
  if (!selected) return
  const selectedFormat = selected.format || 'openai'
  data.providers = data.providers.map(p => ({
    ...p,
    // Exactly one native card per format is active; other formats keep theirs.
    isActive: (p.format || 'openai') === selectedFormat ? p.id === id : p.isActive,
    // Selecting a native route only changes that target format's effective route.
    routerEffectiveFormats: routed ? selectRouterFormat(p.routerEffectiveFormats, selectedFormat, p.id === id) : p.routerEffectiveFormats,
  }))
  data.activeProviderId = id
  await setStorageData(data)
})

export async function getActiveProvider(): Promise<Provider | null> {
  const data = await getStorageData()
  if (!data.activeProviderId) return null
  return data.providers.find(p => p.id === data.activeProviderId) || null
}

export const clearAllProviders = serializeStorageMutation(async (): Promise<void> => {
  const data = await getStorageData()
  await setStorageData({ providers: [], activeProviderId: null, sites: data.sites })
})

export const reorderProviders = serializeStorageMutation(async (orderedIds: string[]): Promise<void> => {
  const data = await getStorageData()
  const map = new Map(data.providers.map(p => [p.id, p]))
  data.providers = orderedIds.map(id => map.get(id)).filter(Boolean) as Provider[]
  await setStorageData(data)
})

export const reorderSites = serializeStorageMutation(async (orderedIds: string[]): Promise<void> => {
  const data = await getStorageData()
  const map = new Map(data.sites.map(s => [s.id, s]))
  data.sites = orderedIds.map(id => map.get(id)).filter(Boolean) as Site[]
  await setStorageData(data)
})

export async function getSites() {
  const data = await getStorageData()
  return data.sites
}

export const addSite = serializeStorageMutation(async (site: Omit<import('../types').Site, 'id' | 'createdAt' | 'updatedAt'>): Promise<import('../types').Site> => {
  const data = await getStorageData()
  const now = Date.now()
  const newSite: import('../types').Site = { ...site, id: generateUUID(), createdAt: now, updatedAt: now }
  data.sites.push(newSite)
  await setStorageData(data)
  return newSite
})

export const updateSite = serializeStorageMutation(async (id: string, updates: Partial<Omit<import('../types').Site, 'id' | 'createdAt'>>): Promise<import('../types').Site | null> => {
  const data = await getStorageData()
  const index = data.sites.findIndex(s => s.id === id)
  if (index === -1) return null
  data.sites[index] = { ...data.sites[index], ...updates, updatedAt: Date.now() }
  await setStorageData(data)
  return data.sites[index]
})

export const deleteSite = serializeStorageMutation(async (id: string): Promise<void> => {
  const data = await getStorageData()
  data.sites = data.sites.filter(s => s.id !== id)
  await setStorageData(data)
})
