import type { Message, MessageResponse, Provider, TestResult, ChatMessage, ChatSession, ExportData, Site } from '../types'

function localDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
import {
  getProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  reorderProviders,
  getSites,
  addSite,
  updateSite,
  deleteSite,
  reorderSites,
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
import { updateCodexSystemForProvider, updateClaudeSettingsForProvider } from '../utils/systemConfig'

chrome.sidePanel.setOptions({ path: 'sidepanel.html' })

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.sidePanel.open({ tabId: tab.id })
})

chrome.alarms.create('autoCheckin', { periodInMinutes: 1 })
chrome.alarms.create('refreshScheduledMinute', { when: getNextMidnight(), periodInMinutes: 24 * 60 })

function getNextMidnight(): number {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
  return midnight.getTime()
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'autoCheckin') {
    await performAutoCheckin()
  } else if (alarm.name === 'refreshScheduledMinute') {
    await refreshScheduledMinutes()
  }
})

async function refreshScheduledMinutes() {
  const sites = await getSites()
  for (const site of sites) {
    if (!site.autoCheckin || !site.checkinTimeRange) continue
    const { startHour, endHour } = site.checkinTimeRange
    const totalMinutes = (endHour - startHour) * 60
    const scheduledMinute = Math.floor(Math.random() * totalMinutes)
    await updateSite(site.id, {
      checkinTimeRange: { startHour, endHour, scheduledMinute },
      checkinStatus: undefined,
      checkinDate: undefined,
    })
  }
}

async function performAutoCheckin(): Promise<MessageResponse> {
  const sites = await getSites()
  const today = localDateStr()
  const now = new Date()
  const currentHour = now.getHours()
  const currentMinute = now.getMinutes()

  const eligible = sites.filter(site => {
    if (!site.autoCheckin) return false
    if (site.checkinDate === today && site.checkinStatus?.isSuccess) return false
    if (site.checkinTimeRange) {
      const { startHour, endHour, scheduledMinute } = site.checkinTimeRange
      if (startHour <= endHour) {
        if (currentHour < startHour || currentHour >= endHour) return false
      } else {
        if (currentHour < startHour && currentHour >= endHour) return false
      }
      if (scheduledMinute != null) {
        const targetHour = startHour + Math.floor(scheduledMinute / 60)
        const targetMin = scheduledMinute % 60
        if (currentHour < targetHour || (currentHour === targetHour && currentMinute < targetMin)) return false
      }
    }
    return true
  })

  if (eligible.length > 0) {
    for (const site of eligible) {
      await checkinSiteOnce(site, today)
    }
    const updatedSites = await getSites()
    const autoSites = updatedSites.filter(s => s.autoCheckin)
    const allCheckedIn = autoSites.every(s => s.checkinDate === today && s.checkinStatus)
    if (allCheckedIn) {
      await handleSendWebhook({ sites: updatedSites, today })
    }
  }
  return { success: true }
}

async function handleAnyRouterCheckin(site: Site, today: string) {
  try {
    const tab = await chrome.tabs.create({ url: site.url, active: false })
    await new Promise(resolve => setTimeout(resolve, 10000))
    try { await chrome.tabs.remove(tab.id!) } catch {}
    const status = { lastTestTime: Date.now(), isSuccess: true, errorMessage: 'Visited site for checkin' }
    await updateSite(site.id, { checkinStatus: status, checkinDate: today })
  } catch (error) {
    const status = { lastTestTime: Date.now(), isSuccess: false, errorMessage: error instanceof Error ? error.message : 'Checkin failed' }
    await updateSite(site.id, { checkinStatus: status, checkinDate: today })
  }
}

async function handleAnyRouterCheckinMessage(payload: { site: Site }): Promise<MessageResponse<import('../types').TestResult>> {
  try {
    const tab = await chrome.tabs.create({ url: payload.site.url, active: false })
    await new Promise(resolve => setTimeout(resolve, 10000))
    try { await chrome.tabs.remove(tab.id!) } catch {}
    return { success: true, data: { success: true, statusCode: 200, message: 'Visited site for checkin', responseBody: 'Visited site for checkin' } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Checkin failed' }
  }
}

async function checkinSiteOnce(site: Site, today: string) {
  if (site.siteType === 'anyrouter') {
    await handleAnyRouterCheckin(site, today)
    return
  }

  let checkinOk = false
  let verificationBlocked = false

  if (site.accessToken) {
    const tokenResult = await handleCheckinSite({ site, manual: false })
    if (tokenResult.success && tokenResult.data?.success) {
      checkinOk = true
      const status = { lastTestTime: Date.now(), isSuccess: true, statusCode: tokenResult.data.statusCode, errorMessage: tokenResult.data.error, responseBody: tokenResult.data.responseBody }
      await updateSite(site.id, { checkinStatus: status, checkinDate: today })
    } else if (tokenResult.data?.error === 'verification_blocked') {
      verificationBlocked = true
    }
  }

  if (!checkinOk && site.cookie) {
    const cookieResult = await handleCheckinSite({ site, manual: false })
    if (cookieResult.success && cookieResult.data?.success) {
      checkinOk = true
      const status = { lastTestTime: Date.now(), isSuccess: true, statusCode: cookieResult.data.statusCode, errorMessage: cookieResult.data.error, responseBody: cookieResult.data.responseBody }
      await updateSite(site.id, { checkinStatus: status, checkinDate: today })
    } else {
      const errMsg = cookieResult.error || (cookieResult.data && !cookieResult.data.success ? cookieResult.data.error : undefined)
      const status = { lastTestTime: Date.now(), isSuccess: false, errorMessage: errMsg || 'Checkin failed' }
      await updateSite(site.id, { checkinStatus: status, checkinDate: today })
      if (cookieResult.data?.error === 'verification_blocked') {
        verificationBlocked = true
      }
    }
  } else if (!checkinOk && !site.accessToken && !site.cookie) {
    const status = { lastTestTime: Date.now(), isSuccess: false, errorMessage: 'No access token or cookie available' }
    await updateSite(site.id, { checkinStatus: status, checkinDate: today })
  }

  // Only open tab once per site if verification blocked
  if (!checkinOk && verificationBlocked) {
    const checkinPageUrl = `${new URL(site.url.replace(/\/+$/, '')).origin}/console/personal`
    await chrome.tabs.create({ url: checkinPageUrl, active: true })
  }
}

chrome.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse)
    return true
  }
)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'chat-stream') {
    port.onMessage.addListener(async (msg: { baseUrl: string; apiKey: string; model: string; messages: ChatMessage[]; apiType?: import('../types').ApiType; format?: import('../types').ProviderFormat }) => {
      try {
        for await (const chunk of streamChat(msg.baseUrl, msg.apiKey, msg.model, msg.messages, msg.apiType || 'both', msg.format || 'openai')) {
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

      case 'REORDER_PROVIDERS':
        return handleReorderProviders(message.payload as string[])

      case 'REORDER_SITES':
        return handleReorderSites(message.payload as string[])

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

      case 'PERFORM_PENDING_CHECKIN':
        return performAutoCheckin()

      case 'TEST_SITE':
        return handleTestSite(message.payload as Site)

      case 'CHECKIN_SITE':
        return handleCheckinSite(message.payload as { site: Site; manual?: boolean })

      case 'CHECKIN_ANYROUTER':
        return handleAnyRouterCheckinMessage(message.payload as { site: Site })

      case 'FETCH_SITE_MODELS':
        return handleFetchSiteModels(message.payload as { url: string; accessToken?: string; cookie?: string; authType?: import('../types').SiteAuthType })

      case 'CREATE_SITE_TOKEN':
        return handleCreateSiteToken(message.payload as { url: string; accessToken?: string; cookie?: string; name?: string; userId?: string; authType?: import('../types').SiteAuthType })

      case 'FETCH_SITE_BALANCE':
        return handleFetchSiteBalance(message.payload as { url: string; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType })

      case 'REFRESH_ALL_BALANCES':
        return handleRefreshAllBalances()

      case 'FETCH_PROVIDER_MODELS':
        return handleFetchProviderModels(message.payload as { baseUrl: string; apiKey?: string; format?: string })

      case 'FETCH_SITE_USER_ID':
        return handleFetchSiteUserId(message.payload as { siteUrl: string; accessToken?: string; cookie?: string; authType?: import('../types').SiteAuthType })

      case 'FETCH_BROWSER_COOKIES':
        return handleFetchBrowserCookies(message.payload as { url: string })

      case 'VALIDATE_SITE_COOKIE':
        return handleValidateSiteCookie(message.payload as { url: string; cookie?: string; userId?: string })

      case 'FETCH_SITE_TOKEN_INFO':
        return handleFetchSiteTokenInfo(message.payload as { url: string; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType })

      case 'FETCH_SITE_TOKEN_KEY':
        return handleFetchSiteTokenKey(message.payload as { url: string; tokenId: number; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType })

      case 'SEND_WEBHOOK':
        return handleSendWebhook(message.payload as { sites: Site[]; today: string })

      case 'FETCH_SYSTEM_ACCESS_TOKEN':
        return handleFetchSystemAccessToken(message.payload as { siteUrl: string; cookie: string })

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

async function handleReorderProviders(orderedIds: string[]): Promise<MessageResponse> {
  await reorderProviders(orderedIds)
  return { success: true }
}

async function handleReorderSites(orderedIds: string[]): Promise<MessageResponse> {
  await reorderSites(orderedIds)
  return { success: true }
}

async function handleSetActiveProvider(payload: { id: string; sync?: boolean }): Promise<MessageResponse> {
  const { id, sync = true } = payload
  await setActiveProvider(id)
  if (sync) {
    const providers = await getProviders()
    const current = providers.find(p => p.id === id)
    if (current) {
      const syncResult = current.format === 'anthropic'
        ? await updateClaudeSettingsForProvider(current)
        : await updateCodexSystemForProvider(current)
      if (!syncResult.success) {
        console.warn('Config sync failed', syncResult.error)
        return { success: false, error: syncResult.error || 'Config sync failed' }
      }
    }
  }
  return { success: true }
}

async function handleTestProvider(provider: Provider): Promise<MessageResponse<TestResult>> {
  if (!provider.model) {
    return { success: false, error: '请先选择模型再测试' }
  }
  const result = await testProviderConnection(provider.baseUrl, provider.apiKey, provider.model, provider.apiType || 'both', provider.format || 'openai')

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
    const text = await response.text()
    const result: TestResult = {
      success: response.ok,
      statusCode: response.status,
      message: `${response.status}`,
      error: response.ok ? undefined : `${response.status}`,
      responseBody: text.slice(0, 500),
    }

    await updateSite(site.id, {
      testStatus: {
        lastTestTime: Date.now(),
        isSuccess: result.success,
        statusCode: result.statusCode,
        errorMessage: result.error,
        responseBody: result.responseBody,
      },
    })

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

const QUOTA_CONVERSION_FACTOR = 500000

function formatBalance(quota: number, unit?: import('../types').BalanceUnit, customLabel?: string): string {
  switch (unit) {
    case 'cny':
      return `¥${(quota / QUOTA_CONVERSION_FACTOR).toFixed(2)}`
    case 'custom':
      return `${customLabel || ''}${(quota / QUOTA_CONVERSION_FACTOR).toFixed(2)}`
    case 'usd':
    default:
      return `$${(quota / QUOTA_CONVERSION_FACTOR).toFixed(2)}`
  }
}

async function handleFetchSiteModels(payload: { url: string; accessToken?: string; cookie?: string; authType?: import('../types').SiteAuthType }): Promise<MessageResponse<string[]>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')

    if (payload.accessToken) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const headers: Record<string, string> = { 'Authorization': `Bearer ${payload.accessToken}` }

      const response = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        let models: string[] = []
        if (Array.isArray(data?.data)) {
          models = data.data.map((m: any) => m.id || m.name || m).filter((n: any) => typeof n === 'string')
        } else if (Array.isArray(data)) {
          models = data.map((m: any) => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean)
        }
        return { success: true, data: models }
      }
    }

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const result = await fetchInSiteContext(baseUrl, '/v1/models')
    if (isSiteContextSuccess(result) && result.ok && result.data) {
      const models = result.data?.data?.map((m: any) => m.id) || result.data?.map((m: any) => m.id) || []
      return { success: true, data: models }
    }

    if (result && 'error' in result) {
      return { success: false, error: `获取模型列表失败: ${result.error}` }
    }

    return { success: false, error: '获取模型列表失败。' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleFetchProviderModels(payload: { baseUrl: string; apiKey?: string; format?: string }): Promise<MessageResponse<string[]>> {
  try {
    const baseUrl = payload.baseUrl.replace(/\/+$/, '')
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (payload.apiKey) {
      if (payload.format === 'anthropic') {
        headers['x-api-key'] = payload.apiKey
      } else {
        headers['Authorization'] = `Bearer ${payload.apiKey}`
      }
    }

    const base = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
    }

    const data = await response.json()

    let models: string[] = []
    if (Array.isArray(data?.data)) {
      models = data.data.map((m: any) => m.id || m.name || m).filter((n: any) => typeof n === 'string')
    } else if (Array.isArray(data)) {
      models = data.map((m: any) => typeof m === 'string' ? m : (m.id || m.name || '')).filter(Boolean)
    }

    if (models.length === 0) {
      return { success: false, error: 'No models found' }
    }

    return { success: true, data: models }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

const COMPAT_USER_ID_HEADERS = [
  'New-API-User',
  'Veloera-User',
  'voapi-user',
  'User-id',
  'Rix-Api-User',
  'neo-api-user',
] as const

function buildCompatUserIdHeaders(userId: string | null | undefined): Record<string, string> {
  if (!userId) return {}
  const value = String(userId)
  const headers: Record<string, string> = {}
  for (const name of COMPAT_USER_ID_HEADERS) {
    headers[name] = value
  }
  return headers
}

function tryDecodeJwtUserId(token: string): string | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    const id = payload?.id ?? payload?.sub ?? payload?.userId ?? payload?.user_id
    if (id !== undefined && id !== null && id !== '') return String(id)
  } catch {}
  return null
}

function decodeGobUint(buf: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  if (offset >= buf.length) return null
  const b = buf[offset]
  if (b <= 0x7f) return { value: b, nextOffset: offset + 1 }
  const n = 256 - b
  if (n <= 0 || n > 8 || offset + 1 + n > buf.length) return null
  let val = 0
  for (let i = 0; i < n; i++) {
    val = (val << 8) | buf[offset + 1 + i]
  }
  return { value: val, nextOffset: offset + 1 + n }
}

function safeAtob(b64: string): string | null {
  try {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/')
    const pad = s.length % 4
    if (pad === 2) s += '=='
    else if (pad === 3) s += '='
    return atob(s)
  } catch { return null }
}

function extractUserIdFromSessionCookie(cookieValue: string): string | null {
  try {
    let sessionPart = cookieValue.trim()
    const sessionPrefix = 'session='
    const semicolonIdx = sessionPart.indexOf(';')
    const sessionEqIdx = sessionPart.indexOf(sessionPrefix)
    if (sessionEqIdx !== -1) {
      const start = sessionEqIdx + sessionPrefix.length
      const end = sessionPart.indexOf(';', start)
      sessionPart = end === -1 ? sessionPart.substring(start) : sessionPart.substring(start, end)
    } else if (semicolonIdx !== -1) {
      return null
    }

    const binaryStr = safeAtob(sessionPart)
    if (!binaryStr) return null
    const p1 = binaryStr.indexOf('|')
    const p2 = binaryStr.indexOf('|', p1 + 1)
    if (p1 === -1 || p2 === -1) return null

    const gobBinary = safeAtob(binaryStr.substring(p1 + 1, p2))
    if (!gobBinary) return null
    const gob = new Uint8Array(gobBinary.length)
    for (let i = 0; i < gobBinary.length; i++) gob[i] = gobBinary.charCodeAt(i)

    const idIdx = gobBinary.indexOf('id')
    if (idIdx === -1) return null

    for (let i = idIdx + 2; i < gob.length - 1; i++) {
      const result = decodeGobUint(gob, i)
      if (result && result.value > 0 && result.value < 2000000) {
        const after = gobBinary.substring(result.nextOffset, result.nextOffset + 10)
        if (after.includes('string')) {
          const intVal = result.value & 1 ? -((result.value + 1) >> 1) : result.value >> 1
          return String(intVal)
        }
      }
    }
    return null
  } catch { return null }
}

async function getUserIdFromSessionCookie(siteUrl: string): Promise<string | null> {
  try {
    const cookies = await chrome.cookies.getAll({ url: siteUrl, name: 'session' })
    if (!cookies.length) return null
    const sessionValue = cookies[0]?.value
    if (!sessionValue) return null
    return extractUserIdFromSessionCookie(sessionValue)
  } catch { return null }
}

async function setManualCookies(siteUrl: string, cookieString: string): Promise<boolean> {
  const url = new URL(siteUrl)
  const isSecure = url.protocol === 'https:'
  const existingCookies = await chrome.cookies.getAll({ url: siteUrl })
  const existingNames = new Set(existingCookies.map(c => c.name))
  const pairs = cookieString.split(';').map(s => s.trim()).filter(Boolean)
  let allOk = true
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const name = pair.slice(0, eqIdx).trim()
    const value = pair.slice(eqIdx + 1).trim()
    if (existingNames.has(name)) continue
    try {
      const result = await chrome.cookies.set({
        url: siteUrl,
        name,
        value,
        domain: url.hostname,
        path: '/',
        secure: isSecure,
        sameSite: isSecure ? 'no_restriction' : 'unspecified',
      })
      if (!result) {
        allOk = false
      }
    } catch {
      allOk = false
    }
  }
  return allOk
}

type SiteContextFetchResult = { ok: boolean; status: number; data: any } | { error: string }

function isSiteContextSuccess(result: SiteContextFetchResult | null): result is { ok: boolean; status: number; data: any } {
  return result != null && 'ok' in result && 'status' in result
}

const sessionRefreshCooldown = new Map<string, number>()
const SESSION_REFRESH_COOLDOWN_MS = 30 * 60 * 1000

async function refreshSessionCookie(siteUrl: string): Promise<boolean> {
  const origin = new URL(siteUrl).origin
  const lastAttempt = sessionRefreshCooldown.get(origin) || 0
  if (Date.now() - lastAttempt < SESSION_REFRESH_COOLDOWN_MS) {
    console.log('[refreshSessionCookie] Cooldown active for', origin, '- skipping')
    return false
  }
  sessionRefreshCooldown.set(origin, Date.now())
  try {
    const url = new URL(siteUrl)
    const tab = await chrome.tabs.create({ url: url.origin, active: false })
    if (!tab.id) return false
    try {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 15000)
        const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (tabId === tab.id && info.status === 'complete') {
            clearTimeout(timeout)
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
      return true
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {})
    }
  } catch {
    return false
  }
}

async function fetchInSiteContext(siteUrl: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<SiteContextFetchResult | null> {
  const url = new URL(siteUrl)
  let tabs = await chrome.tabs.query({ url: `${url.origin}/*` })
  let createdTabId: number | null = null

  if (!tabs.length || !tabs[0].id) {
    const tab = await chrome.tabs.create({ url: url.origin, active: false })
    if (!tab.id) {
      console.error('[fetchInSiteContext] Failed to create tab for', url.origin)
      return null
    }
    createdTabId = tab.id
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[fetchInSiteContext] Tab load timeout for', url.origin)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }, 30000)
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === createdTabId && info.status === 'complete') {
          clearTimeout(timeout)
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    tabs = await chrome.tabs.query({ url: `${url.origin}/*` })
    if (!tabs.length && createdTabId) {
      try {
        const tab = await chrome.tabs.get(createdTabId)
        if (tab) tabs = [tab]
      } catch {}
    }
  }

  const tabId = tabs[0]?.id || createdTabId
  if (!tabId) {
    console.error('[fetchInSiteContext] No tab available for', url.origin)
    return null
  }

  try {
    const fetchUrl = `${url.origin}${path}`
    const fetchOptions = { method: options.method, headers: options.headers, body: options.body }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (innerUrl: string, innerOptions: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const docCookies = typeof document !== 'undefined' ? document.cookie : ''
        const hasSession = docCookies.includes('session=')
        return fetch(innerUrl, {
          method: innerOptions.method || 'GET',
          headers: innerOptions.headers || {},
          body: innerOptions.body,
          credentials: 'include',
        }).then(async (res) => {
          const text = await res.text()
          let data: any = null
          try { data = JSON.parse(text) } catch {}
          return { ok: res.ok, status: res.status, data, _diag: { hasSessionCookie: hasSession, cookieLength: docCookies.length, cookieNames: docCookies.split('; ').map(c => c.split('=')[0]).join(',') } }
        }).catch((err: any) => {
          return { error: `Fetch failed: ${err?.message || String(err)}`, _diag: { hasSessionCookie: hasSession, cookieLength: docCookies.length } }
        })
      },
      args: [fetchUrl, fetchOptions],
    })

    const result = results?.[0]?.result
    if (!result) {
      console.error('[fetchInSiteContext] Script returned no result', { fetchUrl, tabId })
      return null
    }
    if ('_diag' in result) {
      console.log('[fetchInSiteContext] Cookie diagnostic:', result._diag)
    }
    if ('error' in result && !('ok' in result)) {
      console.error('[fetchInSiteContext] Fetch error in tab:', result.error, { fetchUrl })
      return result
    }
    return result
  } catch (scriptErr) {
    console.error('[fetchInSiteContext] Script injection failed:', scriptErr, { tabId, path })
    return null
  } finally {
    if (createdTabId) {
      chrome.tabs.remove(createdTabId).catch(() => {})
    }
  }
}

async function getUserIdFromLocalStorage(siteUrl: string): Promise<string | null> {
  try {
    const url = new URL(siteUrl)
    let tabs = await chrome.tabs.query({ url: `${url.origin}/*` })
    let createdTabId: number | null = null

    if (!tabs.length || !tabs[0].id) {
      const tab = await chrome.tabs.create({ url: url.origin, active: false })
      if (!tab.id) return null
      createdTabId = tab.id
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { resolve() }, 8000)
        const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (tabId === createdTabId && info.status === 'complete') {
            clearTimeout(timeout)
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
      tabs = await chrome.tabs.query({ url: `${url.origin}/*` })
    }

    const tabId = tabs[0]?.id || createdTabId
    if (!tabId) return null

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            const userStr = localStorage.getItem('user')
            if (userStr) {
              const user = JSON.parse(userStr)
              if (user?.id) return { id: String(user.id), accessToken: user.access_token || '' }
            }
            const tokenStr = localStorage.getItem('token')
            if (tokenStr) {
              try {
                const parts = tokenStr.split('.')
                if (parts.length === 3) {
                  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
                  const id = payload?.id ?? payload?.sub ?? payload?.userId
                  if (id) return { id: String(id), accessToken: tokenStr }
                }
              } catch {}
            }
            return null
          } catch { return null }
        },
      })

      const result = results?.[0]?.result
      if (result?.id) return result.id
      return null
    } finally {
      if (createdTabId) {
        chrome.tabs.remove(createdTabId).catch(() => {})
      }
    }
  } catch { return null }
}

async function getUserIdViaCookie(siteUrl: string, manualCookie?: string, userIdHint?: string): Promise<string | null> {
  try {
    if (manualCookie) {
      await setManualCookies(siteUrl, manualCookie)
    }

    const headers: Record<string, string> = { 'Accept': 'application/json' }
    if (userIdHint) {
      for (const name of COMPAT_USER_ID_HEADERS) {
        headers[name] = String(userIdHint)
      }
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`${siteUrl}/api/user/self`, {
        method: 'GET',
        signal: controller.signal,
        headers,
        credentials: 'include',
      })
      clearTimeout(timeoutId)
      if (response.ok) {
        const data = await response.json()
        const userId = data?.data?.id ?? data?.id
        if (userId != null) return String(userId)
      }
    } catch {}

    const result = await fetchInSiteContext(siteUrl, '/api/user/self', { headers })
    if (isSiteContextSuccess(result) && result.ok && result.data) {
      const userId = result.data?.data?.id ?? result.data?.id
      if (userId != null) return String(userId)
    }

    return null
  } catch { return null }
}

async function handleFetchSiteUserId(payload: { siteUrl: string; accessToken?: string; cookie?: string; authType?: import('../types').SiteAuthType }): Promise<MessageResponse<string>> {
  try {
    const siteUrl = payload.siteUrl.replace(/\/+$/, '')

    if (payload.accessToken) {
      const jwtId = tryDecodeJwtUserId(payload.accessToken)
      if (jwtId) {
        return { success: true, data: jwtId }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${payload.accessToken}`,
        ...buildCompatUserIdHeaders(jwtId),
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const response = await fetch(`${siteUrl}/api/user/self`, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        const userId = data?.data?.id ?? data?.id
        if (userId != null) {
          return { success: true, data: String(userId) }
        }
      }
    }

    if (payload.cookie) {
      await setManualCookies(siteUrl, payload.cookie)
      const parsedId = extractUserIdFromSessionCookie(payload.cookie)
      if (parsedId) {
        return { success: true, data: parsedId }
      }
    }

    const sessionUserId = await getUserIdFromSessionCookie(siteUrl)
    if (sessionUserId) {
      return { success: true, data: sessionUserId }
    }

    const lsUserId = await getUserIdFromLocalStorage(siteUrl)
    if (lsUserId) {
      return { success: true, data: lsUserId }
    }

    const cookieUserId = await getUserIdViaCookie(siteUrl, payload.cookie)
    if (cookieUserId) {
      return { success: true, data: cookieUserId }
    }

    return { success: false, error: '无法获取 User ID。请确保已在浏览器中登录该站点，或在站点页面上打开此扩展。' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleFetchBrowserCookies(payload: { url: string }): Promise<MessageResponse<string>> {
  try {
    const url = payload.url.replace(/\/+$/, '')
    const cookies = await chrome.cookies.getAll({ url })
    if (!cookies || cookies.length === 0) {
      return { success: false, error: '未找到该站点的 Cookie。请先在浏览器中登录该站点。' }
    }
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    return { success: true, data: cookieStr }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleValidateSiteCookie(payload: { url: string; cookie?: string; userId?: string }): Promise<MessageResponse<import('../types').CookieStatus>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const headers: Record<string, string> = { 'Accept': 'application/json' }
    if (payload.userId) {
      for (const name of COMPAT_USER_ID_HEADERS) {
        headers[name] = String(payload.userId)
      }
    }

    const result = await fetchInSiteContext(baseUrl, '/api/user/self', { headers })
    if (isSiteContextSuccess(result) && result.ok && result.data) {
      const userId = result.data?.data?.id ?? result.data?.id
      if (userId != null) {
        return { success: true, data: 'valid' }
      }
    }

    return { success: true, data: 'invalid' }
  } catch {
    return { success: true, data: 'unknown' }
  }
}

async function handleFetchSystemAccessToken(payload: { siteUrl: string; cookie: string; userId?: string }): Promise<MessageResponse<string>> {
  try {
    const baseUrl = payload.siteUrl.replace(/\/+$/, '')

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...buildCompatUserIdHeaders(payload.userId),
    }

    const result = await fetchInSiteContext(baseUrl, '/api/user/token', {
      method: 'GET',
      headers,
    })

    if (isSiteContextSuccess(result) && result.ok && result.data) {
      const accessToken = result.data?.data
      if (typeof accessToken === 'string' && accessToken.length > 0) {
        return { success: true, data: accessToken }
      }
    }

    if (result && 'error' in result) {
      return { success: false, error: `获取系统访问令牌失败: ${result.error}` }
    }

    return { success: false, error: '获取系统访问令牌失败，请确保已登录该站点。' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleCreateSiteToken(payload: { url: string; cookie?: string; name?: string; userId?: string }): Promise<MessageResponse<boolean>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')
    const tokenBody = JSON.stringify({
      name: payload.name || 'CodexSwitch',
      remain_quota: 0,
      remain_amount: 0,
      expired_time: -1,
      unlimited_quota: true,
      model_limits_enabled: false,
      model_limits: '',
      cross_group_retry: false,
      allow_ips: '',
      group: 'default',
    })

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Cache-Control': 'no-store',
      ...buildCompatUserIdHeaders(payload.userId),
    }

    try {
      const allCookies = await chrome.cookies.getAll({ url: baseUrl })
      const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader
      }
    } catch {}

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    const response = await fetch(`${baseUrl}/api/token/`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: tokenBody,
    })

    clearTimeout(timeoutId)

    if (response.ok) {
      const data = await response.json()
      if (data.success !== false) {
        return { success: true, data: true }
      }
      return { success: false, error: `创建令牌失败: ${data.message || 'unknown'}` }
    }

    return { success: false, error: `创建令牌失败: HTTP ${response.status}` }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleFetchSiteTokenInfo(payload: { url: string; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType }): Promise<MessageResponse<Array<{ id: number; group: string }>>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')

    if (payload.accessToken) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${payload.accessToken}`,
      }
      if (payload.userId) {
        for (const name of COMPAT_USER_ID_HEADERS) {
          headers[name] = String(payload.userId)
        }
      }

      const response = await fetch(`${baseUrl}/api/token/?p=1&size=10`, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        if (data.success !== false) {
          const items = data?.data?.items
          if (Array.isArray(items) && items.length > 0) {
            const tokens = items.filter((t: any) => typeof t.id === 'number').map((t: any) => ({ id: t.id, group: t.group || 'default' }))
            if (tokens.length > 0) return { success: true, data: tokens }
          }
        }
      }
    }

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const compatHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    if (payload.userId) {
      for (const name of COMPAT_USER_ID_HEADERS) {
        compatHeaders[name] = String(payload.userId)
      }
    }

    try {
      const allCookies = await chrome.cookies.getAll({ url: baseUrl })
      const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
      if (cookieHeader) {
        compatHeaders['Cookie'] = cookieHeader
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`${baseUrl}/api/token/?p=1&size=10`, {
        method: 'GET',
        signal: controller.signal,
        headers: compatHeaders,
      })
      clearTimeout(timeoutId)
      if (response.ok) {
        const data = await response.json()
        const items = data?.data?.items
        if (Array.isArray(items) && items.length > 0) {
          const tokens = items.filter((t: any) => typeof t.id === 'number').map((t: any) => ({ id: t.id, group: t.group || 'default' }))
          if (tokens.length > 0) return { success: true, data: tokens }
        }
      }
    } catch {}

    return { success: false, error: '获取令牌信息失败' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleFetchSiteTokenKey(payload: { url: string; tokenId: number; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType }): Promise<MessageResponse<string>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')

    if (payload.accessToken) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${payload.accessToken}`,
      }
      if (payload.userId) {
        for (const name of COMPAT_USER_ID_HEADERS) {
          headers[name] = String(payload.userId)
        }
      }

      const response = await fetch(`${baseUrl}/api/token/${payload.tokenId}/key`, {
        method: 'POST',
        signal: controller.signal,
        headers,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        if (data.success !== false) {
          const key = data.data?.key
          if (typeof key === 'string') {
            return { success: true, data: key.startsWith('sk-') ? key : `sk-${key}` }
          }
        }
      }
    }

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const compatHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    if (payload.userId) {
      for (const name of COMPAT_USER_ID_HEADERS) {
        compatHeaders[name] = String(payload.userId)
      }
    }

    try {
      const allCookies = await chrome.cookies.getAll({ url: baseUrl })
      const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
      if (cookieHeader) {
        compatHeaders['Cookie'] = cookieHeader
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)
      const response = await fetch(`${baseUrl}/api/token/${payload.tokenId}/key`, {
        method: 'POST',
        signal: controller.signal,
        headers: compatHeaders,
      })
      clearTimeout(timeoutId)
      if (response.ok) {
        const data = await response.json()
        const key = data?.data?.key
        if (typeof key === 'string') {
          return { success: true, data: key.startsWith('sk-') ? key : `sk-${key}` }
        }
      }
    } catch {}

    return { success: false, error: '获取令牌密钥失败' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

type WebhookType = 'wecom' | 'dingtalk' | 'feishu' | 'generic'

function detectWebhookType(url: string): WebhookType {
  if (url.includes('qyapi.weixin.qq.com')) return 'wecom'
  if (url.includes('oapi.dingtalk.com')) return 'dingtalk'
  if (url.includes('open.feishu.cn')) return 'feishu'
  return 'generic'
}

function buildWebhookPayload(type: WebhookType, today: string, siteDetails: { name: string; url: string; status: string; message?: string }[], stats: { totalSites: number; enabledSites: number; disabledSites: number; successCount: number; failedCount: number; pendingCount: number }): { headers: Record<string, string>; body: string } {
  const siteLines = siteDetails.map(s => `${s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏳'} ${s.name}${s.message ? ' - ' + s.message : ''}`)
  const summaryLine = `总站点: ${stats.totalSites} | 已开启签到: ${stats.enabledSites} | 未开启签到: ${stats.disabledSites} | 签到成功: ${stats.successCount} | 签到失败: ${stats.failedCount} | 待签到: ${stats.pendingCount}`

  switch (type) {
    case 'wecom': {
      const content = [
        `📋 CodexSwitch 签到报告 (${today})`,
        summaryLine,
        '',
        ...siteLines,
      ].join('\n')
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content } }),
      }
    }
    case 'dingtalk': {
      const text = [
        `## 📋 CodexSwitch 签到报告 (${today})`,
        '',
        summaryLine,
        '',
        ...siteLines,
      ].join('\n\n')
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'CodexSwitch 签到报告', text } }),
      }
    }
    case 'feishu': {
      const elements: any[] = [
        { tag: 'div', text: { tag: 'lark_md', content: summaryLine } },
        { tag: 'hr' },
      ]
      for (const s of siteDetails) {
        const icon = s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏳'
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${icon} **${s.name}**${s.message ? '\n   ' + s.message : ''}` } })
      }
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msg_type: 'interactive',
          card: {
            header: { title: { tag: 'plain_text', content: `📋 CodexSwitch 签到报告 (${today})` }, template: 'blue' },
            elements,
          },
        }),
      }
    }
    default: {
      const lines = [
        `📋 CodexSwitch 签到报告 (${today})`,
        summaryLine,
        '',
        ...siteLines,
      ]
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'CodexSwitch 签到报告',
          date: today,
          summary: { totalSites: stats.totalSites, enabledSites: stats.enabledSites, disabledSites: stats.disabledSites, successCount: stats.successCount, failedCount: stats.failedCount, pendingCount: stats.pendingCount },
          sites: siteDetails,
          content: lines.join('\n'),
          text: lines.join('\n'),
          message: lines.join('\n'),
        }),
      }
    }
  }
}

async function handleSendWebhook(payload: { sites: Site[]; today: string }): Promise<MessageResponse> {
  try {
    const { webhook_url, webhook_enabled } = await chrome.storage.local.get(['webhook_url', 'webhook_enabled'])
    console.log('[webhook] enabled:', webhook_enabled, 'url:', webhook_url)
    if (!webhook_enabled || !webhook_url) return { success: false, error: 'Webhook not enabled or URL not set' }

    const allSites = payload.sites
    const today = payload.today
    const autoSites = allSites.filter(s => s.autoCheckin)
    const totalSites = allSites.length
    const enabledSites = autoSites.length
    const disabledSites = totalSites - enabledSites
    const successCount = autoSites.filter(s => s.checkinDate === today && s.checkinStatus?.isSuccess).length
    const failedCount = autoSites.filter(s => s.checkinDate === today && s.checkinStatus && !s.checkinStatus.isSuccess).length
    const pendingCount = autoSites.filter(s => s.checkinDate !== today || !s.checkinStatus).length

    const siteDetails = autoSites.map(s => ({
      name: s.name,
      url: s.url,
      status: s.checkinDate === today && s.checkinStatus?.isSuccess ? 'success' : s.checkinDate === today && s.checkinStatus && !s.checkinStatus.isSuccess ? 'failed' : 'pending',
      message: s.checkinStatus?.errorMessage || undefined,
    }))

    const stats = { totalSites, enabledSites, disabledSites, successCount, failedCount, pendingCount }
    const type = detectWebhookType(webhook_url)
    console.log('[webhook] detected type:', type)

    const { headers, body } = buildWebhookPayload(type, today, siteDetails, stats)
    console.log('[webhook] sending to:', webhook_url, 'body:', body.slice(0, 500))

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(webhook_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    const responseText = await response.text()
    console.log('[webhook] response status:', response.status, 'body:', responseText.slice(0, 500))

    if (response.ok) {
      return { success: true, data: responseText.slice(0, 200) }
    }
    return { success: false, error: `HTTP ${response.status}: ${responseText.slice(0, 200)}` }
  } catch (error) {
    console.error('[webhook] error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleFetchSiteBalance(payload: { url: string; accessToken?: string; cookie?: string; userId?: string; authType?: import('../types').SiteAuthType; balanceUnit?: import('../types').BalanceUnit; balanceCustomUnit?: string }): Promise<MessageResponse<string>> {
  try {
    const baseUrl = payload.url.replace(/\/+$/, '')
    const unit = payload.balanceUnit || 'usd'
    const customLabel = payload.balanceCustomUnit

    if (payload.accessToken) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)
      const effectiveUserId = payload.userId || tryDecodeJwtUserId(payload.accessToken)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${payload.accessToken}`,
        ...buildCompatUserIdHeaders(effectiveUserId),
      }

      const response = await fetch(`${baseUrl}/api/user/self`, {
        method: 'GET',
        signal: controller.signal,
        headers,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = await response.json()
        const quota = data?.data?.quota || data?.quota || 0
        return { success: true, data: formatBalance(quota, unit, customLabel) }
      }
    }

    if (payload.cookie) {
      await setManualCookies(baseUrl, payload.cookie)
    }

    const compatHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    if (payload.userId) {
      for (const name of COMPAT_USER_ID_HEADERS) {
        compatHeaders[name] = String(payload.userId)
      }
    }

    try {
      const allCookies = await chrome.cookies.getAll({ url: baseUrl })
      const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
      if (cookieHeader) {
        compatHeaders['Cookie'] = cookieHeader
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000)
      const response = await fetch(`${baseUrl}/api/user/self`, {
        method: 'GET',
        signal: controller.signal,
        headers: compatHeaders,
      })
      clearTimeout(timeoutId)
      if (response.ok) {
        const data = await response.json()
        const quota = data?.data?.quota || data?.quota || 0
        return { success: true, data: formatBalance(quota, unit, customLabel) }
      }
    } catch {}

    return { success: false, error: '获取余额失败' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

async function handleRefreshAllBalances(): Promise<MessageResponse> {
  try {
    const sites = await getSites()
    const providers = await getProviders()

    for (const site of sites) {
      if (!site.accessToken && !site.cookie) continue

      const result = await handleFetchSiteBalance({
        url: site.url,
        accessToken: site.accessToken,
        cookie: site.cookie,
        userId: site.userId,
        balanceUnit: site.balanceUnit,
        balanceCustomUnit: site.balanceCustomUnit,
      })
      if (result.success && result.data) {
        await updateSite(site.id, { balance: result.data as string })
        if (site.providerId) {
          await updateProvider(site.providerId, { balance: result.data as string })
        }
      }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

const ALREADY_CHECKED_SNIPPETS = ['今天已经签到', '已经签到', '已签到', 'already']

function isAlreadyCheckedMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return ALREADY_CHECKED_SNIPPETS.some(s => lower.includes(s.toLowerCase()))
}

async function turnstileAssistedCheckin(
  siteUrl: string,
  compatHeaders: Record<string, string>,
  _userId: string | undefined,
): Promise<TestResult | null> {
  const url = new URL(siteUrl)
  const checkinPageUrl = `${url.origin}/checkin`

  try {
    let tab: chrome.tabs.Tab | null = null
    let createdTabId: number | null = null

    const existingTabs = await chrome.tabs.query({ url: `${url.origin}/*` })
    if (existingTabs.length > 0 && existingTabs[0].id) {
      tab = existingTabs[0]
    } else {
      tab = await chrome.tabs.create({ url: checkinPageUrl, active: false })
      if (!tab.id) return null
      createdTabId = tab.id
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 15000)
        const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (tabId === createdTabId && info.status === 'complete') {
            clearTimeout(timeout)
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 2000))
    }

    const tabId = tab.id!
    try {
      const turnstileToken = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          return new Promise<string | null>((resolve) => {
            const timeout = setTimeout(() => resolve(null), 15000)
            const tryGetToken = () => {
              const input = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
              if (input && input.value) {
                clearTimeout(timeout)
                resolve(input.value)
                return
              }
              const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]')
              if (!iframe) {
                const btn = document.querySelector<HTMLButtonElement>('button[type="submit"], .checkin-btn, #checkin-btn')
                if (btn) btn.click()
              }
            }
            tryGetToken()
            const interval = setInterval(() => {
              tryGetToken()
            }, 1000)
            const origResolve = resolve
            resolve = ((value: string | null) => {
              clearInterval(interval)
              origResolve(value)
            }) as typeof resolve
          })
        },
      })

      const token = turnstileToken?.[0]?.result
      console.log('[turnstile] Token obtained:', token ? `${token.slice(0, 20)}...` : 'null')

      if (!token) {
        console.log('[turnstile] No token obtained, trying direct checkin in page context')
      }

      const checkinWithToken = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (fetchUrl: string, headers: Record<string, string>, turnstileToken: string | null) => {
          const h: Record<string, string> = { ...headers }
          if (turnstileToken) {
            h['cf-turnstile-response'] = turnstileToken
          }
          return fetch(fetchUrl, {
            method: 'POST',
            headers: h,
            body: '{}',
            credentials: 'include',
          }).then(async (res) => {
            const text = await res.text()
            let data: any = null
            try { data = JSON.parse(text) } catch {}
            return { ok: res.ok, status: res.status, data }
          }).catch((err: any) => ({ error: `Fetch failed: ${err?.message || String(err)}` }))
        },
        args: [`${url.origin}/api/user/checkin`, compatHeaders, token || null],
      })

      const result = checkinWithToken?.[0]?.result
      if (result && 'ok' in result) {
        const parsed: { success?: boolean; message?: string } = result.data || {}
        const message = parsed.message || ''
        const isSuccess = parsed.success === true || isAlreadyCheckedMessage(message)
        const isAlreadyChecked = isAlreadyCheckedMessage(message)

        if (isSuccess) {
          sessionRefreshCooldown.delete(new URL(siteUrl).origin)
        }
        return {
          success: isSuccess,
          statusCode: result.status,
          message: isAlreadyChecked ? 'Already checked in today' : (message || `${result.status}`),
          error: isSuccess ? undefined : (message || `${result.status}`),
          responseBody: JSON.stringify(result.data).slice(0, 500),
        }
      }

      return null
    } finally {
      if (createdTabId) {
        chrome.tabs.remove(createdTabId).catch(() => {})
      }
    }
  } catch (e) {
    console.error('[turnstile] Error:', e)
    return null
  }
}

async function handleCheckinSite(payload: { site: Site; manual?: boolean }): Promise<MessageResponse<TestResult>> {
  const { site, manual } = payload
  if (!manual && site.checkinTimeRange) {
    const now = new Date()
    const hour = now.getHours()
    const { startHour, endHour } = site.checkinTimeRange
    if (startHour <= endHour) {
      if (hour < startHour || hour >= endHour) {
        return { success: false, error: `Outside check-in time range (${startHour}:00-${endHour}:00)` }
      }
    } else {
      if (hour < startHour && hour >= endHour) {
        return { success: false, error: `Outside check-in time range (${startHour}:00-${endHour}:00)` }
      }
    }
  }

  try {
    const siteUrl = site.url.replace(/\/+$/, '')

    let userId: string | undefined = site.userId
    let checkinHeaders: Record<string, string>

    if (site.accessToken) {
      let token = site.accessToken.trim()
      if (token.toLowerCase().startsWith('bearer ')) {
        token = token.slice(7).trim()
      }

      if (!userId) {
        userId = tryDecodeJwtUserId(token) ?? undefined
      }
      if (!userId) {
        userId = (await getUserIdFromSessionCookie(siteUrl)) ?? undefined
      }
      if (!userId) {
        userId = (await getUserIdFromLocalStorage(siteUrl)) ?? undefined
      }
      if (!userId) {
        userId = (await getUserIdViaCookie(siteUrl)) ?? undefined
      }
      if (!userId) {
        try {
          const userController = new AbortController()
          const userTimeoutId = setTimeout(() => userController.abort(), 10000)
          const userRes = await fetch(`${siteUrl}/api/user/self`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/json',
              ...buildCompatUserIdHeaders(null),
            },
            signal: userController.signal,
          })
          clearTimeout(userTimeoutId)
          if (userRes.ok) {
            const userText = await userRes.text()
            let userData: any
            try { userData = JSON.parse(userText) } catch {}
            const rawId = userData?.data?.id ?? userData?.id
            if (rawId !== undefined && rawId !== null && rawId !== '') {
              userId = String(rawId)
            }
          }
        } catch {}
      }

      checkinHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Pragma': 'no-cache',
        'Authorization': `Bearer ${token}`,
        ...buildCompatUserIdHeaders(userId),
      }
    } else if (site.cookie) {
      if (!userId) {
        userId = (await getUserIdFromSessionCookie(siteUrl)) ?? undefined
      }

      if (!userId && site.cookie) {
        userId = extractUserIdFromSessionCookie(site.cookie) ?? undefined
      }

      if (!userId) {
        userId = (await getUserIdFromLocalStorage(siteUrl)) ?? undefined
      }

      if (!userId) {
        return { success: false, error: 'Cookie 认证需要 User ID。请手动输入 User ID 或在浏览器中打开该站点后重试。' }
      }

      const existingCookies = await chrome.cookies.getAll({ url: siteUrl })
      const sessionCookies = existingCookies.filter(c => c.name === 'session')
      const hasSessionCookie = sessionCookies.length > 0

      console.log('[checkin] Available cookies:', existingCookies.map(c => `${c.name}(${c.value.length}chars,httpOnly=${c.httpOnly},sameSite=${c.sameSite})`).join('; '))

      if (!hasSessionCookie && site.cookie) {
        console.log('[checkin] No session cookie, setting manual cookies from user input')
        await setManualCookies(siteUrl, site.cookie)
      }

      if (sessionCookies.length > 1) {
        console.log('[checkin] Multiple session cookies found, validating each one in site context')
        const validCookies: chrome.cookies.Cookie[] = []
        for (const sc of sessionCookies) {
          const otherSessions = sessionCookies.filter(c => c !== sc)
          for (const oc of otherSessions) {
            const cookieUrl = `${oc.secure ? 'https' : 'http'}://${oc.domain.replace(/^\./, '')}${oc.path}`
            await chrome.cookies.remove({ url: cookieUrl, name: oc.name, storeId: oc.storeId })
          }

          const testResult = await fetchInSiteContext(siteUrl, '/api/user/self', {
            headers: { 'Accept': 'application/json' },
          })
          if (isSiteContextSuccess(testResult) && testResult.ok) {
            validCookies.push(sc)
            console.log('[checkin] Session cookie valid:', `httpOnly=${sc.httpOnly},sameSite=${sc.sameSite},len=${sc.value.length}`)
          } else {
            const status = isSiteContextSuccess(testResult) ? testResult.status : 'error'
            console.log('[checkin] Session cookie invalid:', `httpOnly=${sc.httpOnly},sameSite=${sc.sameSite},len=${sc.value.length},status=${status}`)
          }

          for (const oc of otherSessions) {
            await chrome.cookies.set({
              url: `${oc.secure ? 'https' : 'http'}://${oc.domain.replace(/^\./, '')}${oc.path}`,
              name: oc.name,
              value: oc.value,
              domain: oc.domain,
              path: oc.path,
              secure: oc.secure,
              httpOnly: oc.httpOnly,
              sameSite: oc.sameSite,
              expirationDate: oc.expirationDate,
              storeId: oc.storeId,
            }).catch(() => {})
          }
        }

        for (const sc of sessionCookies) {
          if (!validCookies.includes(sc)) {
            const cookieUrl = `${sc.secure ? 'https' : 'http'}://${sc.domain.replace(/^\./, '')}${sc.path}`
            await chrome.cookies.remove({ url: cookieUrl, name: sc.name, storeId: sc.storeId })
            console.log('[checkin] Removed invalid session cookie:', `httpOnly=${sc.httpOnly},sameSite=${sc.sameSite},len=${sc.value.length}`)
          }
        }
        const afterCleanup = await chrome.cookies.getAll({ url: siteUrl })
        console.log('[checkin] After validation:', afterCleanup.filter(c => c.name === 'session').map(c => `httpOnly=${c.httpOnly},sameSite=${c.sameSite},len=${c.value.length}`).join('; '))
      }

      const pureCookieHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      }

      const compatHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Pragma': 'no-cache',
      }
      for (const name of COMPAT_USER_ID_HEADERS) {
        compatHeaders[name] = String(userId)
      }

      const allCookies = await chrome.cookies.getAll({ url: siteUrl })
      const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ')
      if (cookieHeader) {
        pureCookieHeaders['Cookie'] = cookieHeader
        compatHeaders['Cookie'] = cookieHeader
      }

      let checkinResult: SiteContextFetchResult | null = null

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)
        const response = await fetch(`${siteUrl}/api/user/checkin`, {
          method: 'POST',
          signal: controller.signal,
          headers: pureCookieHeaders,
          body: '{}',
        })
        clearTimeout(timeoutId)
        const text = await response.text()
        let data: any = null
        try { data = JSON.parse(text) } catch {}
        checkinResult = { ok: response.ok, status: response.status, data }
        console.log('[checkin] Direct cookie header fetch result:', response.status, text.slice(0, 200))
      } catch (e) {
        console.error('[checkin] Direct cookie header fetch failed:', e)
      }

      if (!isSiteContextSuccess(checkinResult) || (checkinResult.status === 401 || checkinResult.status === 403)) {
        console.log('[checkin] Direct cookie header fetch unauthorized, retrying with compat headers')
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 10000)
          const response = await fetch(`${siteUrl}/api/user/checkin`, {
            method: 'POST',
            signal: controller.signal,
            headers: compatHeaders,
            body: '{}',
          })
          clearTimeout(timeoutId)
          const text = await response.text()
          let data: any = null
          try { data = JSON.parse(text) } catch {}
          checkinResult = { ok: response.ok, status: response.status, data }
          console.log('[checkin] Compat headers fetch result:', response.status, text.slice(0, 200))
        } catch (e) {
          console.error('[checkin] Compat headers fetch failed:', e)
        }
      }

      if ((!isSiteContextSuccess(checkinResult) || (checkinResult.status === 401 || checkinResult.status === 403)) && site.autoRefreshCookie) {
        console.log('[checkin] Cookie expired, auto-refreshing session via background tab')
        try {
          const refreshed = await refreshSessionCookie(siteUrl)
          if (refreshed) {
            const freshCookies = await chrome.cookies.getAll({ url: siteUrl })
            const freshCookieHeader = freshCookies.map(c => `${c.name}=${c.value}`).join('; ')
            if (freshCookieHeader) {
              pureCookieHeaders['Cookie'] = freshCookieHeader
              compatHeaders['Cookie'] = freshCookieHeader
            }
            try {
              const controller = new AbortController()
              const timeoutId = setTimeout(() => controller.abort(), 10000)
              const response = await fetch(`${siteUrl}/api/user/checkin`, {
                method: 'POST',
                signal: controller.signal,
                headers: compatHeaders,
                body: '{}',
              })
              clearTimeout(timeoutId)
              const text = await response.text()
              let data: any = null
              try { data = JSON.parse(text) } catch {}
              checkinResult = { ok: response.ok, status: response.status, data }
              console.log('[checkin] Retry after session refresh:', response.status, text.slice(0, 200))
            } catch (e) {
              console.error('[checkin] Retry after session refresh failed:', e)
            }
          }
        } catch (e) {
          console.error('[checkin] Session refresh failed:', e)
        }
      }

      if (isSiteContextSuccess(checkinResult)) {
        const parsed: { success?: boolean; message?: string; data?: any } = checkinResult.data || {}
        const message = parsed.message || ''

        console.log('[checkin] Cookie path response:', JSON.stringify(checkinResult.data).substring(0, 200))

        const isSuccess = parsed.success === true || isAlreadyCheckedMessage(message)
        const isAlreadyChecked = isAlreadyCheckedMessage(message)

        // Check-in failed due to verification/captcha
        if (!isSuccess && !isAlreadyChecked) {
          const fullText = `${message} ${parsed.data ? JSON.stringify(parsed.data) : ''}`.toLowerCase()
          const isVerificationBlocked = (
            fullText.includes('验证码') ||
            fullText.includes('captcha') ||
            fullText.includes('请先验证') ||
            fullText.includes('turnstile') ||
            fullText.includes('签名') ||
            fullText.includes('校验') ||
            fullText.includes('验证')
          )
          return { success: true, data: { success: false, statusCode: 0, message: isVerificationBlocked ? '签到需要验证' : message || '签到失败', error: isVerificationBlocked ? 'verification_blocked' : message || 'checkin_failed' } }
        }

        if (isSuccess) {
          sessionRefreshCooldown.delete(new URL(siteUrl).origin)
        }

        const result: TestResult = {
          success: isSuccess,
          statusCode: checkinResult.status,
          message: isAlreadyChecked ? 'Already checked in today' : (message || `${checkinResult.status}`),
          error: isSuccess ? undefined : (message || `${checkinResult.status}`),
          responseBody: JSON.stringify(checkinResult.data).slice(0, 500),
        }

        if (userId && userId !== site.userId) {
          updateSite(site.id, { userId }).catch(() => {})
        }

        return { success: true, data: result }
      }

      return { success: false, error: 'Cookie 认证签到失败。请确保已在浏览器中登录该站点。' }
    } else {
      return { success: false, error: 'Access Token 或 Cookie 是签到必需的' }
    }

    if (userId && userId !== site.userId) {
      updateSite(site.id, { userId }).catch(() => {})
    }

    if (!userId) {
      return {
        success: false,
        error: 'User ID is required for check-in. Please enter it in the site settings or click Fetch to auto-detect.',
      }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    const response = await fetch(`${siteUrl}/api/user/checkin`, {
      method: 'POST',
      signal: controller.signal,
      headers: checkinHeaders,
      body: '{}',
    })

    clearTimeout(timeoutId)
    const text = await response.text()

    let parsed: { success?: boolean; message?: string; data?: any } = {}
    try { parsed = JSON.parse(text) } catch {}

    const message = parsed.message || ''

    console.log('[checkin] Response:', response.status, text.substring(0, 200))

    const isSuccess = parsed.success === true || isAlreadyCheckedMessage(message)
    const isAlreadyChecked = isAlreadyCheckedMessage(message)

    // Check-in failed due to verification/captcha
    if (!isSuccess && !isAlreadyChecked) {
      const fullText = `${message} ${parsed.data ? JSON.stringify(parsed.data) : ''}`.toLowerCase()
      const isVerificationBlocked = (
        fullText.includes('验证码') ||
        fullText.includes('captcha') ||
        fullText.includes('请先验证') ||
        fullText.includes('turnstile') ||
        fullText.includes('签名') ||
        fullText.includes('校验') ||
        fullText.includes('验证')
      )
      return { success: true, data: { success: false, statusCode: response.status, message: isVerificationBlocked ? '签到需要验证' : message || '签到失败', error: isVerificationBlocked ? 'verification_blocked' : message || 'checkin_failed' } }
    }

    const result: TestResult = {
      success: isSuccess,
      statusCode: response.status,
      message: isAlreadyChecked ? 'Already checked in today' : (message || `${response.status}`),
      error: isSuccess ? undefined : (message || `${response.status}`),
      responseBody: text.slice(0, 500),
    }

    return { success: true, data: result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}
