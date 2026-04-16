import type { Message, MessageResponse, Provider, TestResult } from '../types'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
} from '../utils/storage'
import { testProviderConnection } from '../utils/api'
import { exportProviders, validateExportData, importProviders } from '../utils/export'

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse)
    return true
  }
)

async function handleMessage(message: Message): Promise<MessageResponse> {
  try {
    switch (message.type) {
      case 'GET_PROVIDERS':
        return handleGetProviders()

      case 'ADD_PROVIDER':
        return handleAddProvider(message.payload as Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>)

      case 'UPDATE_PROVIDER':
        return handleUpdateProvider(message.payload as { id: string; updates: Partial<Provider> })

      case 'DELETE_PROVIDER':
        return handleDeleteProvider(message.payload as string)

      case 'SET_ACTIVE_PROVIDER':
        return handleSetActiveProvider(message.payload as string)

      case 'TEST_PROVIDER':
        return handleTestProvider(message.payload as Provider)

      case 'EXPORT_PROVIDERS':
        return handleExportProviders()

      case 'IMPORT_PROVIDERS':
        return handleImportProviders(message.payload as unknown)

      default:
        return { success: false, error: 'Unknown message type' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

async function handleGetProviders(): Promise<MessageResponse<Provider[]>> {
  const providers = await getProviders()
  return { success: true, data: providers }
}

async function handleAddProvider(
  provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>
): Promise<MessageResponse<Provider>> {
  const newProvider = await addProvider(provider)
  return { success: true, data: newProvider }
}

async function handleUpdateProvider(payload: {
  id: string
  updates: Partial<Provider>
}): Promise<MessageResponse<Provider>> {
  const updated = await updateProvider(payload.id, payload.updates)
  if (!updated) {
    return { success: false, error: 'Provider not found' }
  }
  return { success: true, data: updated }
}

async function handleDeleteProvider(id: string): Promise<MessageResponse> {
  await deleteProvider(id)
  return { success: true }
}

async function handleSetActiveProvider(id: string): Promise<MessageResponse> {
  await setActiveProvider(id)
  return { success: true }
}

async function handleTestProvider(provider: Provider): Promise<MessageResponse<TestResult>> {
  const result = await testProviderConnection(provider.baseUrl, provider.apiKey)

  await updateProvider(provider.id, {
    testStatus: {
      lastTestTime: Date.now(),
      isSuccess: result.success,
      errorMessage: result.error,
    },
  })

  return { success: true, data: result }
}

async function handleExportProviders(): Promise<MessageResponse> {
  const providers = await getProviders()
  const data = exportProviders(providers)
  return { success: true, data }
}

async function handleImportProviders(data: unknown): Promise<MessageResponse> {
  const validation = validateExportData(data)
  if (!validation.valid) {
    return { success: false, error: validation.errors?.join(', ') }
  }

  const providers = importProviders(data as Parameters<typeof importProviders>[0])
  for (const provider of providers) {
    await addProvider(provider)
  }

  return { success: true }
}
