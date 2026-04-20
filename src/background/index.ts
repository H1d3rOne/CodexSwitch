import type { Message, MessageResponse, Provider, TestResult, ChatMessage, ChatSession, ExportData, Site } from '../types'
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getSites,
  addSite,
  updateSite,
  deleteSite,
} from '../utils/storage'
import { testProviderConnection, streamChat } from '../utils/api'
import { exportProviders, validateExportData, importProviders } from '../utils/export'
import {
  getChatSessions,
  getActiveSessionId,
  setActiveSessionId,
  saveChatSession,
  deleteChatSession,
} from '../utils/chat'
import { updateCodexSystemForProvider } from '../utils/systemConfig'

chrome.sidePanel.setOptions({ path: 'sidepanel.html' })

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id })
})

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse)
    return true
  }
)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'chat-stream') {
    port.onMessage.addListener(async (msg: { baseUrl: string; apiKey: string; model: string; messages: ChatMessage[] }) => {
      try {
        for await (const chunk of streamChat(msg.baseUrl, msg.apiKey, msg.model, msg.messages)) {
          port.postMessage({ type: 'chunk', data: chunk })
        }
        port.postMessage({ type: 'done' })
      } catch (e) {
        port.postMessage({ type: 'error', error: e instanceof Error ? e.message : 'Unknown error' })
      }
    })
  }
})

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
        return handleSetActiveProvider(message.payload as { id: string; sync?: boolean })

      case 'TEST_PROVIDER':
        return handleTestProvider(message.payload as Provider)

      case 'UPDATE_TEST_STATUS':
        return handleUpdateTestStatus(message.payload as { id: string; result: TestResult })

      case 'EXPORT_PROVIDERS':
        return handleExportProviders()

      case 'IMPORT_PROVIDERS':
        return handleImportProviders(message.payload as unknown)

      case 'GET_CHAT_SESSIONS':
        return handleGetChatSessions()

      case 'SAVE_CHAT_SESSION':
        return handleSaveChatSession(message.payload as { id: string | null; providerId: string; model: string; messages: ChatMessage[] })

      case 'DELETE_CHAT_SESSION':
        return handleDeleteChatSession(message.payload as string)

      case 'SET_ACTIVE_SESSION':
        return handleSetActiveSession(message.payload as string)

      case 'GET_SITES':
        return handleGetSites()

      case 'ADD_SITE':
        return handleAddSite(message.payload as Omit<Site, 'id' | 'createdAt' | 'updatedAt'>)

      case 'UPDATE_SITE':
        return handleUpdateSite(message.payload as { id: string; updates: Partial<Site> })

      case 'DELETE_SITE':
        return handleDeleteSite(message.payload as string)

      case 'TEST_SITE':
        return handleTestSite(message.payload as Site)

      case 'CHECKIN_SITE':
        return handleCheckinSite(message.payload as Site)

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
  if (!updated) return { success: false, error: 'Provider not found' }
  return { success: true, data: updated }
}

async function handleDeleteProvider(id: string): Promise<MessageResponse> {
  await deleteProvider(id)
  return { success: true }
}

async function handleSetActiveProvider(payload: { id: string; sync?: boolean }): Promise<MessageResponse> {
  const { id, sync = true } = payload
  await setActiveProvider(id)
  if (sync) {
    const providers = await getProviders()
    const current = providers.find(p => p.id === id)
    if (current) {
      const syncResult = await updateCodexSystemForProvider(current)
      if (!syncResult.success) {
        console.warn('Codex system config sync failed', syncResult.error)
        return { success: false, error: syncResult.error || 'Codex system config sync failed' }
      }
    }
  }
  return { success: true }
}

async function handleTestProvider(provider: Provider): Promise<MessageResponse<TestResult>> {
  const result = await testProviderConnection(provider.baseUrl, provider.apiKey, provider.model)

  await updateProvider(provider.id, {
    testStatus: {
      lastTestTime: Date.now(),
      isSuccess: result.success,
      statusCode: result.statusCode,
      errorMessage: result.error,
      responseBody: result.responseBody,
    },
  })

  return { success: true, data: result }
}

async function handleUpdateTestStatus(payload: { id: string; result: TestResult }): Promise<MessageResponse> {
  const { id, result } = payload
  await updateProvider(id, {
    testStatus: {
      lastTestTime: Date.now(),
      isSuccess: result.success,
      statusCode: result.statusCode,
      errorMessage: result.error,
      responseBody: result.responseBody,
    },
  })
  return { success: true }
}

async function handleExportProviders(): Promise<MessageResponse<ExportData>> {
  const providers = await getProviders()
  const data = exportProviders(providers)
  return { success: true, data }
}

async function handleImportProviders(data: unknown): Promise<MessageResponse> {
  const validation = validateExportData(data)
  if (!validation.valid) return { success: false, error: validation.errors?.join(', ') }

  const providers = importProviders(data as Parameters<typeof importProviders>[0])
  for (const provider of providers) await addProvider(provider)
  return { success: true }
}

async function handleGetChatSessions(): Promise<MessageResponse<{ sessions: ChatSession[]; activeId: string | null }>> {
  const sessions = await getChatSessions()
  const activeId = await getActiveSessionId()
  return { success: true, data: { sessions, activeId } }
}

async function handleSaveChatSession(payload: {
  id: string | null
  providerId: string
  model: string
  messages: ChatMessage[]
}): Promise<MessageResponse<ChatSession>> {
  const session = await saveChatSession(payload.id, payload.providerId, payload.model, payload.messages)
  return { success: true, data: session }
}

async function handleDeleteChatSession(id: string): Promise<MessageResponse> {
  await deleteChatSession(id)
  return { success: true }
}

async function handleSetActiveSession(id: string): Promise<MessageResponse> {
  await setActiveSessionId(id)
  return { success: true }
}

async function handleGetSites(): Promise<MessageResponse<Site[]>> {
  const sites = await getSites()
  return { success: true, data: sites }
}

async function handleAddSite(site: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>): Promise<MessageResponse<Site>> {
  const newSite = await addSite(site)
  return { success: true, data: newSite }
}

async function handleUpdateSite(payload: { id: string; updates: Partial<Site> }): Promise<MessageResponse<Site>> {
  const updated = await updateSite(payload.id, payload.updates)
  if (!updated) return { success: false, error: 'Site not found' }
  return { success: true, data: updated }
}

async function handleDeleteSite(id: string): Promise<MessageResponse> {
  await deleteSite(id)
  return { success: true }
}

async function handleTestSite(site: Site): Promise<MessageResponse<TestResult>> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(site.url, {
      method: 'GET',
      signal: controller.signal,
      headers: site.token ? { Authorization: `Bearer ${site.token}` } : {},
    })

    clearTimeout(timeoutId)
    const result: TestResult = {
      success: response.ok,
      statusCode: response.status,
      message: `${response.status}`,
      error: response.ok ? undefined : `${response.status}`,
    }

    await updateSite(site.id, {
      testStatus: {
        lastTestTime: Date.now(),
        isSuccess: result.success,
        statusCode: result.statusCode,
        errorMessage: result.error,
      },
    })

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

async function handleCheckinSite(site: Site): Promise<MessageResponse<TestResult>> {
  if (!site.checkinUrl) {
    return { success: false, error: 'Checkin URL not configured' }
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const headers: Record<string, string> = {}
    if (site.token) {
      headers['Authorization'] = `Bearer ${site.token}`
    }
    if (site.checkinHeaders) {
      Object.assign(headers, site.checkinHeaders)
    }

    const response = await fetch(site.checkinUrl, {
      method: site.checkinMethod || 'POST',
      signal: controller.signal,
      headers,
    })

    clearTimeout(timeoutId)
    const text = await response.text()

    const result: TestResult = {
      success: response.ok,
      statusCode: response.status,
      message: `${response.status}`,
      error: response.ok ? undefined : `${response.status}`,
      responseBody: text.slice(0, 500),
    }

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}
