import type { Provider, StorageData } from '../types'
import { generateUUID } from './uuid'

const STORAGE_KEY = 'codex_switch_data'

async function getStorageData(): Promise<StorageData> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const raw = result[STORAGE_KEY] || {}

  return {
    providers: Array.isArray(raw.providers) ? raw.providers : [],
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

export async function addProvider(
  provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Provider> {
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
}

export async function updateProvider(
  id: string,
  updates: Partial<Omit<Provider, 'id' | 'createdAt'>>
): Promise<Provider | null> {
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
}

export async function deleteProvider(id: string): Promise<void> {
  const data = await getStorageData()
  data.providers = data.providers.filter(p => p.id !== id)
  if (data.activeProviderId === id) {
    data.activeProviderId = null
  }
  await setStorageData(data)
}

export async function setActiveProvider(id: string): Promise<void> {
  const data = await getStorageData()
  data.providers = data.providers.map(p => ({
    ...p,
    isActive: p.id === id,
  }))
  data.activeProviderId = id
  await setStorageData(data)
}

export async function getActiveProvider(): Promise<Provider | null> {
  const data = await getStorageData()
  if (!data.activeProviderId) return null
  return data.providers.find(p => p.id === data.activeProviderId) || null
}

export async function clearAllProviders(): Promise<void> {
  const data = await getStorageData()
  await setStorageData({ providers: [], activeProviderId: null, sites: data.sites })
}

export async function getSites() {
  const data = await getStorageData()
  return data.sites
}

export async function addSite(site: Omit<import('../types').Site, 'id' | 'createdAt' | 'updatedAt'>): Promise<import('../types').Site> {
  const data = await getStorageData()
  const now = Date.now()
  const newSite: import('../types').Site = { ...site, id: generateUUID(), createdAt: now, updatedAt: now }
  data.sites.push(newSite)
  await setStorageData(data)
  return newSite
}

export async function updateSite(id: string, updates: Partial<Omit<import('../types').Site, 'id' | 'createdAt'>>): Promise<import('../types').Site | null> {
  const data = await getStorageData()
  const index = data.sites.findIndex(s => s.id === id)
  if (index === -1) return null
  data.sites[index] = { ...data.sites[index], ...updates, updatedAt: Date.now() }
  await setStorageData(data)
  return data.sites[index]
}

export async function deleteSite(id: string): Promise<void> {
  const data = await getStorageData()
  data.sites = data.sites.filter(s => s.id !== id)
  await setStorageData(data)
}
