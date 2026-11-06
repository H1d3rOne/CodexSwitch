import type { Message, MessageResponse, Provider, TestResult, ChatMessage, ChatSession, ExportData, Site, AgentRouterLoginType } from '../types'

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
import { buildCheckinAttemptUpdate, isCheckinFinishedForToday, isSiteDueForAutoCheckin, isVerificationBlockedPayload } from '../utils/checkinState'
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

let autoCheckinRunning = false
const verificationTabOpenKeys = new Set<string>()

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
    if (site.enabled === false || !site.autoCheckin || !site.checkinTimeRange) continue
    const { startHour, endHour } = site.checkinTimeRange
    const totalMinutes = (endHour - startHour) * 60
    const scheduledMinute = Math.floor(Math.random() * totalMinutes)
    await updateSite(site.id, {
      checkinTimeRange: { startHour, endHour, scheduledMinute },
      checkinStatus: undefined,
      checkinDate: undefined,
      checkinFinal: undefined,
      checkinRetryCount: undefined,
      nextCheckinRetryAt: undefined,
      verificationTabOpenedDate: undefined,
    })
  }
}

async function performAutoCheckin(): Promise<MessageResponse> {
  if (autoCheckinRunning) return { success: true }

  autoCheckinRunning = true
  try {
    const sites = await getSites()
    const today = localDateStr()
    const now = new Date()

    const eligible = sites.filter(site => isSiteDueForAutoCheckin(site, today, now))

    if (eligible.length > 0) {
      for (const site of eligible) {
        try {
          await checkinSiteOnce(site, today)
        } catch (error) {
          await persistUnexpectedCheckinFailure(site, today, error)
        }
      }
      const updatedSites = await getSites()
      const autoSites = updatedSites.filter(s => s.enabled !== false && s.autoCheckin)
      const allCheckedIn = autoSites.every(s => isCheckinFinishedForToday(s, today))
      if (allCheckedIn) {
        await handleSendWebhook({ sites: updatedSites, today })
      }
    }
    return { success: true }
  } finally {
    autoCheckinRunning = false
  }
}


function buildBoheCheckinResult(result: SiteContextFetchResult, fallbackMessage: string): TestResult {
  if (!isSiteContextSuccess(result)) {
    const message = result?.error || fallbackMessage
    return { success: false, statusCode: 0, message, error: message, responseBody: result?.body }
  }

  const parsed: { success?: boolean; message?: string; data?: any } = result.data || {}
  const message = parsed.message || (parsed.success === true ? '签到成功' : `${result.status}`)
  const responseBody = result.body || JSON.stringify(result.data || {})

  if (!parsed.success) {
    const isVerificationBlocked = isVerificationBlockedPayload({
      statusCode: result.status,
      message,
      data: parsed.data ?? result.data,
      responseBody,
    })
    return {
      success: false,
      statusCode: result.status,
      message: isVerificationBlocked ? '签到需要验证' : message || '签到失败',
      error: isVerificationBlocked ? 'verification_blocked' : message || 'checkin_failed',
      responseBody: responseBody.slice(0, 500),
    }
  }

  return {
    success: true,
    statusCode: result.status,
    message,
    responseBody: responseBody.slice(0, 500),
  }
}

async function fetchBoheWithStoredCookie(siteUrl: string, cookie: string): Promise<SiteContextFetchResult> {
  const origin = new URL(siteUrl).origin
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    const response = await fetch(`${origin}/api/checkin/spin`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Origin': origin,
        'Referer': `${origin}/`,
      },
    })
    clearTimeout(timeoutId)
    const text = await response.text()
    let data: any = null
    try { data = JSON.parse(text) } catch {}
    return { ok: response.ok, status: response.status, data, body: text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: `Fetch failed: ${message}` }
  }
}

async function handleBoheCheckin(site: Site): Promise<TestResult> {
  const siteUrl = site.url.replace(/\/+$/, '')
  const origin = new URL(siteUrl).origin
  const browserCookieResult = await fetchInSiteContext(siteUrl, '/api/checkin/spin', {
    method: 'POST',
    headers: {
      'Accept': '*/*',
      'Content-Type': 'application/json',
    },
    body: '',
  })

  const browserResult = buildBoheCheckinResult(browserCookieResult || { error: '薄荷签到请求失败' }, '薄荷签到请求失败')
  if (browserResult.success || browserResult.error === 'verification_blocked' || !site.cookie?.trim()) {
    if (browserResult.success) {
      console.log('[bohe-checkin] Success with browser cookie:', origin, browserResult.responseBody?.slice(0, 200) || '')
    }
    return browserResult
  }

  const storedCookieResult = await fetchBoheWithStoredCookie(siteUrl, site.cookie.trim())
  const fallbackResult = buildBoheCheckinResult(storedCookieResult, browserResult.message || '薄荷签到请求失败')
  if (fallbackResult.success) {
    console.log('[bohe-checkin] Success with stored cookie fallback:', origin, fallbackResult.responseBody?.slice(0, 200) || '')
  }
  return fallbackResult
}

interface BaibeiTokenPair {
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
}

interface BaibeiAttemptResult {
  result: TestResult
  authFailed: boolean
}

function normalizeBearerToken(token?: string): string {
  return token?.trim().replace(/^Bearer\s+/i, '') || ''
}

function unwrapBaibeiResponse(parsed: any): any {
  if (parsed && typeof parsed === 'object' && parsed.code === 0 && parsed.data && typeof parsed.data === 'object') {
    return parsed.data
  }
  return parsed
}

function isBaibeiAuthFailure(status: number, parsed: any, text: string): boolean {
  if (status === 401 || status === 403) return true
  const message = String(parsed?.message || parsed?.msg || parsed?.error || parsed?.reason || text || '').toLowerCase()
  return /unauthorized|forbidden|expired|invalid token|invalid jwt|jwt|token|auth|login|登录|认证|授权|过期|失效/.test(message)
}

async function requestBaibeiCheckin(origin: string, token: string): Promise<BaibeiAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  const response = await fetch(`${origin}/api/v1/check-in`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: '{}',
  })
  clearTimeout(timeoutId)

  const text = await response.text()
  let parsed: any = {}
  let isJson = false
  try {
    parsed = JSON.parse(text)
    isJson = true
  } catch {}

  const payload = unwrapBaibeiResponse(parsed)
  const message = payload?.message || payload?.msg || parsed?.message || parsed?.msg || (isJson ? `${response.status}` : '百倍签到未返回 JSON')
  const alreadyChecked = isAlreadyCheckedMessage(message)
    || payload?.checked_in_today === true
    || payload?.already_checked_in === true
    || parsed?.data?.checked_in_today === true
    || parsed?.data?.already_checked_in === true
  const explicitSuccess = parsed?.success === true
    || parsed?.code === 0
    || payload?.success === true
    || payload?.checked_in_today === true
    || payload?.already_checked_in === true
  const explicitFailure = parsed?.success === false
    || payload?.success === false
    || (typeof parsed?.code === 'number' && parsed.code !== 0)
    || parsed?.error
    || payload?.error
  const isSuccess = response.ok && isJson && (alreadyChecked || explicitSuccess) && !explicitFailure

  if (!isSuccess) {
    const isVerificationBlocked = isVerificationBlockedPayload({
      statusCode: response.status,
      message,
      data: payload ?? parsed,
      responseBody: text,
    })
    return {
      authFailed: isBaibeiAuthFailure(response.status, parsed, text),
      result: {
        success: false,
        statusCode: response.status,
        message: isVerificationBlocked ? '签到需要验证' : message || '百倍签到失败',
        error: isVerificationBlocked ? 'verification_blocked' : (message || 'checkin_failed'),
        responseBody: text.slice(0, 500),
      },
    }
  }

  return {
    authFailed: false,
    result: {
      success: true,
      statusCode: response.status,
      message: alreadyChecked ? 'Already checked in today' : message,
      responseBody: text.slice(0, 500),
    },
  }
}

async function refreshBaibeiAccessToken(origin: string, refreshToken: string): Promise<BaibeiTokenPair> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  const response = await fetch(`${origin}/api/v1/auth/refresh`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  clearTimeout(timeoutId)

  const text = await response.text()
  let parsed: any = {}
  try { parsed = JSON.parse(text) } catch {
    throw new Error(`Refresh Token 刷新失败: ${response.status} ${text.slice(0, 120)}`)
  }
  const payload = unwrapBaibeiResponse(parsed)
  const accessToken = payload?.access_token || parsed?.access_token
  const nextRefreshToken = payload?.refresh_token || parsed?.refresh_token || refreshToken
  const expiresIn = Number(payload?.expires_in ?? parsed?.expires_in)
  const codeFailed = typeof parsed?.code === 'number' && parsed.code !== 0
  if (!response.ok || codeFailed || !accessToken) {
    const message = parsed?.message || payload?.message || parsed?.error || payload?.error || `HTTP ${response.status}`
    throw new Error(`Refresh Token 刷新失败: ${message}`)
  }
  return {
    accessToken: normalizeBearerToken(accessToken),
    refreshToken: nextRefreshToken,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined,
  }
}

async function persistBaibeiTokens(site: Site, tokens: BaibeiTokenPair): Promise<void> {
  const updates: Partial<Site> = {}
  if (tokens.accessToken) updates.accessToken = normalizeBearerToken(tokens.accessToken)
  if (tokens.refreshToken) updates.refreshToken = tokens.refreshToken.trim()
  if (site.id && Object.keys(updates).length > 0) {
    await updateSite(site.id, updates).catch(() => {})
  }
}

async function handleBaibeiCheckin(site: Site): Promise<TestResult> {
  const origin = new URL(site.url).origin
  let token = normalizeBearerToken(site.accessToken)
  let refreshToken = (site.refreshToken || '').trim()

  if (!token && refreshToken) {
    try {
      const refreshed = await refreshBaibeiAccessToken(origin, refreshToken)
      token = normalizeBearerToken(refreshed.accessToken)
      refreshToken = refreshed.refreshToken || refreshToken
      await persistBaibeiTokens(site, refreshed)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refresh Token 刷新失败'
      return { success: false, statusCode: 0, message, error: message }
    }
  }

  if (!token) {
    return {
      success: false,
      statusCode: 0,
      message: '百倍签到需要 Access Token 或 Refresh Token',
      error: 'missing_access_token',
    }
  }

  try {
    const first = await requestBaibeiCheckin(origin, token)
    if (first.result.success || !first.authFailed || !refreshToken) {
      return first.result
    }

    const refreshed = await refreshBaibeiAccessToken(origin, refreshToken)
    await persistBaibeiTokens(site, refreshed)
    const retry = await requestBaibeiCheckin(origin, normalizeBearerToken(refreshed.accessToken))
    return {
      ...retry.result,
      message: retry.result.success ? `${retry.result.message}（已刷新 Access Token）` : retry.result.message,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '百倍签到失败'
    return {
      success: false,
      statusCode: 0,
      message,
      error: message,
    }
  }
}

async function handleAnyRouterCheckin(site: Site): Promise<TestResult> {
  try {
    const tab = await chrome.tabs.create({ url: site.url, active: false })
    await new Promise(resolve => setTimeout(resolve, 10000))
    try { await chrome.tabs.remove(tab.id!) } catch {}
    return { success: true, statusCode: 200, message: 'Visited site for checkin', responseBody: 'Visited site for checkin' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkin failed'
    return { success: false, statusCode: 0, message, error: message }
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

const AGENT_ROUTER_URL = 'https://agentrouter.org/'

type AgentRouterDomState = 'success' | 'blocked' | 'failed' | 'logged_out' | 'logged_in' | 'clicked'

interface AgentRouterDomResult {
  state: AgentRouterDomState
  message: string
  body?: string
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getTabSafe(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    return null
  }
}

async function closeTabSafe(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId)
  } catch {}
}

async function waitForTabComplete(tabId: number, timeoutMs = 30000): Promise<void> {
  const existing = await getTabSafe(tabId)
  if (!existing) return
  if (existing.status === 'complete') return

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, timeoutMs)

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return
      if (info.status === 'complete') {
        clearTimeout(timeout)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }

    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function navigateAgentRouterTab(tabId: number, url: string, timeoutMs = 30000): Promise<void> {
  await chrome.tabs.update(tabId, { url, active: true })
  await waitForTabComplete(tabId, timeoutMs)
  await sleep(1200)
}

async function reloadAgentRouterTab(tabId: number, timeoutMs = 30000): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache: true })
  await sleep(300)
  await waitForTabComplete(tabId, timeoutMs)
  await sleep(1200)
}

async function openAgentRouterLoginPage(tabId: number, origin: string, timeoutMs = 45000): Promise<void> {
  await navigateAgentRouterTab(tabId, `${origin}/login`, timeoutMs)
  await reloadAgentRouterTab(tabId, timeoutMs)
}

function cookieRemovalUrl(cookie: chrome.cookies.Cookie): string {
  const protocol = cookie.secure ? 'https:' : 'http:'
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  const path = cookie.path || '/'
  return `${protocol}//${domain}${path}`
}

async function clearAgentRouterCookies(): Promise<void> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'agentrouter.org' })
    await Promise.all(cookies.map(cookie => chrome.cookies.remove({
      url: cookieRemovalUrl(cookie),
      name: cookie.name,
      storeId: cookie.storeId,
    }).catch(() => null)))
  } catch (error) {
    console.warn('[AgentRouter] Failed to clear cookies:', error)
  }
}

async function clearAgentRouterSiteData(): Promise<void> {
  await clearAgentRouterCookies()
}

async function runAgentRouterDomStep(
  tabId: number,
  step: 'detectSession' | 'logout' | 'login' | 'authorize' | 'detectAuth' | 'checkin' | 'detectBlocked',
  loginType: AgentRouterLoginType = 'linuxdo'
): Promise<AgentRouterDomResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (innerStep: string, selectedLoginType: string) => {
        type InnerResult = {
          state: 'success' | 'blocked' | 'failed' | 'logged_out' | 'logged_in' | 'clicked'
          message: string
          body?: string
          error?: string
        }

        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
        const compact = (text: string) => text.replace(/\s+/g, ' ').trim()
        const pageText = () => compact(document.body?.innerText || document.documentElement?.textContent || '')
        const sampleBody = () => pageText().slice(0, 500)
        const lowerPageText = () => pageText().toLowerCase()
        const isElementVisible = (el: Element) => {
          const htmlEl = el as HTMLElement
          const style = window.getComputedStyle(htmlEl)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
          const rect = htmlEl.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
        const elementText = (el: Element) => {
          const htmlEl = el as HTMLInputElement & HTMLElement
          return compact([
            htmlEl.innerText,
            htmlEl.textContent,
            htmlEl.getAttribute('aria-label'),
            htmlEl.getAttribute('title'),
            htmlEl.value,
          ].filter(Boolean).join(' '))
        }
        const clickableElements = () => Array.from(document.querySelectorAll(
          'button,a,[role="button"],[role="menuitem"],input[type="button"],input[type="submit"]'
        )).filter(isElementVisible) as HTMLElement[]
        const textIncludesAny = (text: string, patterns: string[]) => {
          const lower = text.toLowerCase()
          return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
        }
        const clickElement = (el: HTMLElement) => {
          try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }))
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
          el.click()
        }
        const clickByText = (patterns: string[], excludes: string[] = []) => {
          for (const el of clickableElements()) {
            const text = elementText(el)
            if (!text) continue
            if (excludes.length && textIncludesAny(text, excludes)) continue
            if (textIncludesAny(text, patterns)) {
              const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
              if (disabled) continue
              clickElement(el)
              return true
            }
          }
          return false
        }
        const providerPatterns = (type: string) => (
          type === 'github'
            ? ['github', '使用 github', '使用 github 继续', 'continue with github', 'sign in with github', 'login with github']
            : ['linuxdo', 'linux do', 'linux.do', '使用 linuxdo', '使用 linuxdo 继续', 'continue with linuxdo', 'sign in with linuxdo', 'login with linuxdo']
        )
        const providerStrongPatterns = (type: string) => (
          type === 'github'
            ? ['github.com/login/oauth/authorize', 'github_oauth', 'github oauth', '使用 github 继续']
            : ['connect.linux.do/oauth2/authorize', 'linuxdo_oauth', 'linuxdo oauth', '使用 linuxdo 继续']
        )
        const providerExcludePatterns = (type: string) => (
          type === 'github'
            ? ['linuxdo', 'linux do', 'linux.do', 'wechat', '微信', 'telegram', 'oidc', '邮箱', '用户名', 'email', 'username']
            : ['github', 'wechat', '微信', 'telegram', 'oidc', '邮箱', '用户名', 'email', 'username']
        )
        const elementSearchText = (el: Element) => {
          const htmlEl = el as HTMLInputElement & HTMLAnchorElement & HTMLElement
          let dataset = ''
          try {
            dataset = Object.keys(htmlEl.dataset || {}).map(key => htmlEl.dataset[key]).filter(Boolean).join(' ')
          } catch {}

          const attrText = [
            elementText(el),
            htmlEl.id,
            htmlEl.className,
            htmlEl.getAttribute('href'),
            htmlEl.getAttribute('action'),
            htmlEl.getAttribute('aria-label'),
            htmlEl.getAttribute('title'),
            htmlEl.getAttribute('name'),
            htmlEl.getAttribute('value'),
            htmlEl.getAttribute('data-provider'),
            htmlEl.getAttribute('data-testid'),
            dataset,
            htmlEl.outerHTML?.slice(0, 1200),
          ].filter(Boolean).join(' ')

          return compact(attrText).toLowerCase()
        }
        const findProviderButton = (type: string): HTMLElement | null => {
          const textPatterns = providerPatterns(type)
          const strongPatterns = providerStrongPatterns(type)
          const excludePatterns = providerExcludePatterns(type)
          let best: { el: HTMLElement; score: number } | null = null

          for (const el of clickableElements()) {
            const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
            if (disabled) continue

            const visibleText = elementText(el)
            const searchText = elementSearchText(el)
            const matchesText = textIncludesAny(visibleText, textPatterns)
            const matchesStrong = textIncludesAny(searchText, strongPatterns)
            const matchesLoose = textIncludesAny(searchText, textPatterns)
            if (!matchesText && !matchesStrong && !matchesLoose) continue

            const matchesOtherProvider = excludePatterns.some(pattern => searchText.includes(pattern.toLowerCase()))
            if (matchesOtherProvider && !matchesText && !matchesStrong) continue

            const score = (matchesText ? 100 : 0) + (matchesStrong ? 40 : 0) + (matchesLoose ? 10 : 0) - (matchesOtherProvider ? 20 : 0)
            if (!best || score > best.score) {
              best = { el, score }
            }
          }

          return best?.el || null
        }
        const clickProviderButton = async (type: string, timeoutMs = 5000) => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < timeoutMs) {
            const el = findProviderButton(type)
            if (el) {
              clickElement(el)
              return true
            }
            await wait(250)
          }
          return false
        }
        const isAgentRouterLoginPath = () => {
          const path = window.location.pathname.toLowerCase()
          return path.includes('/login') || path.includes('/sign-in')
        }
        const hasProviderButton = (type: string) => {
          return !!findProviderButton(type)
        }
        const fetchJson = async (url: string) => {
          const response = await fetch(url, {
            credentials: 'include',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }
          return response.json()
        }
        const getAgentRouterStatus = async () => {
          try {
            const cached = JSON.parse(window.localStorage.getItem('status') || '{}')
            if (cached?.github_client_id || cached?.linuxdo_client_id) return cached
          } catch {}

          const json = await fetchJson('/api/status')
          const status = json?.data || {}
          try {
            if (status && Object.keys(status).length > 0) {
              window.localStorage.setItem('status', JSON.stringify(status))
            }
          } catch {}
          return status
        }
        const getAgentRouterOAuthState = async () => {
          let endpoint = '/api/oauth/state'
          try {
            const aff = window.localStorage.getItem('aff')
            if (aff && aff.length > 0) endpoint += `?aff=${encodeURIComponent(aff)}`
          } catch {}

          const json = await fetchJson(endpoint)
          if (json?.success && json?.data) return String(json.data)
          throw new Error(json?.message || 'OAuth state unavailable')
        }
        const navigateProviderOAuthDirect = async (type: string) => {
          try {
            const status = await getAgentRouterStatus()
            const state = await getAgentRouterOAuthState()
            const clientId = type === 'github' ? status?.github_client_id : status?.linuxdo_client_id
            if (!clientId) {
              return { ok: false, error: `${type}_client_id_missing` }
            }

            const oauthUrl = type === 'github'
              ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}&scope=user%3Aemail`
              : `https://connect.linux.do/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}`

            window.location.href = oauthUrl
            return { ok: true, url: oauthUrl }
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }
        const hasLoggedInLocalState = () => {
          try {
            const user = window.localStorage.getItem('user')
            if (user) {
              const parsed = JSON.parse(user)
              if (parsed?.id || parsed?.username || parsed?.display_name) return true
            }
          } catch {}
          try {
            if (window.localStorage.getItem('uid')) return true
          } catch {}
          return false
        }
        const clearLocalAuthState = () => {
          try { window.localStorage.clear() } catch {}
          try { window.sessionStorage.clear() } catch {}
        }
        const detectBlocked = (): InnerResult | null => {
          const text = lowerPageText()
          const html = (document.documentElement?.innerHTML || '').toLowerCase()
          const blockedPatterns = [
            'cf-turnstile',
            'turnstile',
            'cloudflare',
            'cdn-cgi/challenge-platform',
            '__cf_chl_',
            'cf-chl-',
            'cf-ray',
            'just a moment',
            'checking your browser',
            'verify you are human',
            'please verify you are human',
            'human verification',
            'managed challenge',
            'hcaptcha',
            'g-recaptcha',
            'recaptcha',
            'geetest',
            'security check',
            'please complete the security check',
            '验证码',
            '人机验证',
            '安全验证',
            '请先验证',
            '请先完成验证',
            '完成验证',
          ]
          if (blockedPatterns.some(pattern => text.includes(pattern) || html.includes(pattern))) {
            return {
              state: 'blocked',
              message: 'AgentRouter 签到需要验证或人工处理',
              error: 'verification_blocked',
              body: sampleBody(),
            }
          }
          return null
        }
        const detectLoginFailure = (): InnerResult | null => {
          const text = lowerPageText()
          const url = window.location.href.toLowerCase()
          const failurePatterns = [
            'login failed',
            'sign in failed',
            'signin failed',
            'authorization failed',
            'authentication failed',
            'oauth failed',
            'oauth error',
            'callback error',
            'could not sign in',
            'failed to sign in',
            'access_denied',
            'invalid_grant',
            'invalid_request',
            'invalid_state',
            'state mismatch',
            '登录失败',
            '登入失败',
            '授权失败',
            '认证失败',
            '验证失败',
            '登录出错',
            '授权出错',
            '未能登录',
            '无法登录',
          ]
          if (failurePatterns.some(pattern => text.includes(pattern) || url.includes(pattern))) {
            return {
              state: 'failed',
              message: 'AgentRouter 登录失败，准备重试登录',
              error: 'login_failed',
              body: sampleBody() || window.location.href,
            }
          }
          return null
        }
        const signOutPatterns = ['sign out', 'logout', 'log out', '退出登录', '退出', '登出', '注销']
        const hasSignOutControl = () => clickableElements().some(item => textIncludesAny(elementText(item), signOutPatterns))
        const clickSignOutConfirmIfVisible = () => clickByText(signOutPatterns, ['cancel', '取消'])
        const openUserMenu = async () => {
          const directMenuButtons = Array.from(document.querySelectorAll(
            'header button[aria-haspopup], nav button[aria-haspopup], header button[data-state], nav button[data-state], header [role="button"], nav [role="button"]'
          )).filter(isElementVisible) as HTMLElement[]
          const allHeaderButtons = Array.from(document.querySelectorAll('header button, nav button')).filter(isElementVisible) as HTMLElement[]
          const candidates = [...directMenuButtons, ...allHeaderButtons]
            .filter((el, idx, arr) => arr.indexOf(el) === idx)
            .sort((a, b) => {
              const ar = a.getBoundingClientRect()
              const br = b.getBoundingClientRect()
              return (br.right - ar.right) || (ar.top - br.top)
            })

          for (const el of candidates.slice(0, 8)) {
            clickElement(el)
            await wait(350)
            if (hasSignOutControl()) {
              return true
            }
          }
          return false
        }
        const isAlreadyCheckedIn = () => {
          const text = lowerPageText()
          return text.includes('checked in') || text.includes('已签到') || text.includes('签到成功')
        }
        const clickCheckinButton = () => {
          if (clickByText(['check in now', '立即签到'])) return true
          for (const el of clickableElements()) {
            const text = elementText(el)
            if (!text.includes('签到')) continue
            if (textIncludesAny(text, ['已签到', '每日签到', '签到奖励', '签到设置', '签到失败', '签到成功'])) continue
            const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
            if (disabled) continue
            clickElement(el)
            return true
          }
          return false
        }

        const blocked = innerStep === 'authorize' ? null : detectBlocked()
        if (blocked) return blocked

        if (innerStep === 'detectBlocked') {
          return { state: 'success', message: 'No verification block detected', body: sampleBody() } satisfies InnerResult
        }

        if (innerStep === 'detectSession') {
          if (isAgentRouterLoginPath() || hasProviderButton('github') || hasProviderButton('linuxdo')) {
            return { state: 'logged_out', message: 'Not logged in; login controls are visible', body: sampleBody() } satisfies InnerResult
          }

          const text = lowerPageText()
          const path = window.location.pathname.toLowerCase()
          if (
            hasLoggedInLocalState() ||
            path.includes('/profile') ||
            text.includes('daily check-in') ||
            text.includes('每日签到') ||
            hasSignOutControl()
          ) {
            return { state: 'logged_in', message: 'Logged in before AgentRouter check-in', body: sampleBody() } satisfies InnerResult
          }

          await openUserMenu()
          await wait(300)
          if (hasSignOutControl()) {
            return { state: 'logged_in', message: 'Logged in; sign-out control found in user menu', body: sampleBody() } satisfies InnerResult
          }

          return { state: 'logged_out', message: 'Not logged in; skip sign-out before OAuth login', body: sampleBody() } satisfies InnerResult
        }

        if (innerStep === 'logout') {
          if (isAgentRouterLoginPath() || hasProviderButton('github') || hasProviderButton('linuxdo')) {
            try {
              window.localStorage.removeItem('user')
              window.localStorage.removeItem('uid')
            } catch {}
            return { state: 'logged_out', message: 'Already on login page', body: sampleBody() } satisfies InnerResult
          }

          let clickedSignOut = clickSignOutConfirmIfVisible()
          if (!clickedSignOut) {
            await openUserMenu()
            clickedSignOut = clickSignOutConfirmIfVisible()
          }

          if (clickedSignOut) {
            await wait(800)
            clickSignOutConfirmIfVisible()
            await wait(2200)
          }

          try {
            window.localStorage.removeItem('user')
            window.localStorage.removeItem('uid')
          } catch {}

          return {
            state: 'logged_out',
            message: clickedSignOut ? 'Signed out by DOM click' : 'Sign out control not found; local auth state cleared before OAuth reset',
            body: sampleBody(),
          } satisfies InnerResult
        }

        if (innerStep === 'login') {
          if (hasLoggedInLocalState() && !isAgentRouterLoginPath()) {
            clearLocalAuthState()
            return {
              state: 'logged_out',
              message: 'Cleared stale local auth state before OAuth login',
              body: sampleBody(),
            } satisfies InnerResult
          }

          if (selectedLoginType === 'github') {
            const directOAuth = await navigateProviderOAuthDirect(selectedLoginType)
            if (directOAuth.ok) {
              return { state: 'clicked', message: 'Opened GitHub OAuth directly', body: directOAuth.url } satisfies InnerResult
            }
          }

          if (await clickProviderButton(selectedLoginType, 6000)) {
            return { state: 'clicked', message: `Clicked ${selectedLoginType} login`, body: sampleBody() } satisfies InnerResult
          }

          const clickedOtherLoginOptions = clickByText([
            '其他登录选项',
            '其他登录方式',
            '其他登录方法',
            'other login options',
            'other sign in options',
            'other sign-in options',
            'other login methods',
          ])
          if (clickedOtherLoginOptions || clickByText(['sign in', 'login', '登录', '登入'], ['邮箱', '用户名', 'email', 'username', 'password', '忘记密码', '继续'])) {
            await wait(1000)
            if (selectedLoginType === 'github') {
              const directOAuth = await navigateProviderOAuthDirect(selectedLoginType)
              if (directOAuth.ok) {
                return { state: 'clicked', message: 'Opened GitHub OAuth directly after opening login options', body: directOAuth.url } satisfies InnerResult
              }
            }
            if (await clickProviderButton(selectedLoginType, 6000)) {
              return { state: 'clicked', message: `Clicked ${selectedLoginType} login after opening login page`, body: sampleBody() } satisfies InnerResult
            }
          }

          return {
            state: 'failed',
            message: `未找到 ${selectedLoginType === 'github' ? 'GitHub' : 'LinuxDO'} 登录按钮`,
            error: 'login_button_not_found',
            body: sampleBody(),
          } satisfies InnerResult
        }

        if (innerStep === 'authorize') {
          const text = lowerPageText()
          const loginFailure = detectLoginFailure()
          if (loginFailure) return loginFailure

          const directAuthorizeSelectors = [
            'a.btn-pill-primary[href*="/oauth2/approve/"]',
            'a[href*="/oauth2/approve/"]',
            'form[action*="/oauth2/approve"] button[type="submit"]',
            'form[action*="/oauth2/approve"] input[type="submit"]',
            'button[name="authorize"]',
            'input[name="authorize"]',
            'button[value="authorize"]',
            'input[value="Authorize"]',
            'button#js-oauth-authorize-btn',
            '.js-oauth-authorize-btn',
          ]
          for (const selector of directAuthorizeSelectors) {
            const el = document.querySelector(selector) as HTMLElement | null
            if (!el || !isElementVisible(el)) continue
            const disabled = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
            if (disabled) continue
            const href = el instanceof HTMLAnchorElement ? el.href : ''
            const beforeUrl = window.location.href
            clickElement(el)
            await wait(400)
            const shouldUseHrefFallback = selectedLoginType !== 'linuxdo' && !href.toLowerCase().includes('/oauth2/approve/')
            if (href && shouldUseHrefFallback && window.location.href === beforeUrl) {
              window.location.href = href
            }
            return { state: 'clicked', message: 'Clicked OAuth approve button by selector', body: sampleBody() } satisfies InnerResult
          }

          const oauthBlocked = detectBlocked()
          if (oauthBlocked) return oauthBlocked

          const manualLoginPatterns = [
            'sign in to github',
            'username or email address',
            'two-factor authentication',
            'authentication code',
            'verification code',
            'passkey',
            'sign in with a passkey',
            'login to continue',
            'log in to continue',
            'password',
            '登录 github',
            '登录到 github',
            '登录后继续',
            '请输入密码',
            '两步验证',
            '双重验证',
            '输入验证码',
            '验证码',
          ]
          if (manualLoginPatterns.some(pattern => text.includes(pattern))) {
            return {
              state: 'blocked',
              message: 'OAuth 页面需要手动登录或验证',
              error: 'verification_blocked',
              body: sampleBody(),
            } satisfies InnerResult
          }

          const authorizePatterns = [
            'authorize',
            'allow',
            'approve',
            'grant access',
            'continue',
            '授权',
            '允许',
            '同意',
            '批准',
            '确认授权',
            '继续',
          ]
          const denyPatterns = [
            'cancel',
            'deny',
            'decline',
            'reject',
            '取消',
            '拒绝',
            '返回',
          ]

          if (clickByText(authorizePatterns, denyPatterns)) {
            await wait(1200)
            return { state: 'clicked', message: 'Clicked OAuth authorize button', body: sampleBody() } satisfies InnerResult
          }

          return {
            state: 'failed',
            message: '等待 OAuth 授权页面或授权按钮',
            error: 'authorize_button_not_found',
            body: sampleBody(),
          } satisfies InnerResult
        }

        if (innerStep === 'detectAuth') {
          const loginFailure = detectLoginFailure()
          if (loginFailure) return loginFailure

          if (hasLoggedInLocalState()) {
            return { state: 'logged_in', message: 'Logged in', body: sampleBody() } satisfies InnerResult
          }
          const text = lowerPageText()
          const path = window.location.pathname.toLowerCase()
          if (!isAgentRouterLoginPath() && (path.includes('/profile') || text.includes('daily check-in') || text.includes('每日签到'))) {
            return { state: 'logged_in', message: 'Logged in by page content', body: sampleBody() } satisfies InnerResult
          }
          return { state: 'failed', message: 'Waiting for login', error: 'not_logged_in', body: sampleBody() } satisfies InnerResult
        }

        if (innerStep === 'checkin') {
          if (isAlreadyCheckedIn()) {
            return { state: 'success', message: 'AgentRouter 今日已签到', body: sampleBody() } satisfies InnerResult
          }

          if (!clickCheckinButton()) {
            return {
              state: 'failed',
              message: '未找到 AgentRouter 签到按钮',
              error: 'checkin_button_not_found',
              body: sampleBody(),
            } satisfies InnerResult
          }

          for (let i = 0; i < 20; i += 1) {
            await wait(600)
            const currentBlocked = detectBlocked()
            if (currentBlocked) return currentBlocked
            const text = lowerPageText()
            if (isAlreadyCheckedIn() || text.includes('check-in successful') || text.includes('签到成功')) {
              return { state: 'success', message: 'AgentRouter 签到成功', body: sampleBody() } satisfies InnerResult
            }
            if (text.includes('check-in failed') || text.includes('签到失败')) {
              return {
                state: 'failed',
                message: 'AgentRouter 签到失败',
                error: 'checkin_failed',
                body: sampleBody(),
              } satisfies InnerResult
            }
          }

          return {
            state: 'failed',
            message: 'AgentRouter 签到后未检测到成功状态',
            error: 'checkin_result_unknown',
            body: sampleBody(),
          } satisfies InnerResult
        }

        return { state: 'failed', message: 'Unknown AgentRouter DOM step', error: 'unknown_step', body: sampleBody() } satisfies InnerResult
      },
      args: [step, loginType],
    })
    return results?.[0]?.result as AgentRouterDomResult || {
      state: 'failed',
      message: 'AgentRouter DOM step returned empty result',
      error: 'empty_dom_result',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { state: 'failed', message, error: message }
  }
}

function isAgentRouterOAuthUrl(url: string, loginType?: AgentRouterLoginType): boolean {
  const lower = url.toLowerCase()
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false

  if (lower.includes('connect.linux.do/oauth2/authorize')) return true
  if (lower.includes('connect.linux.do/oauth2/approve')) return true
  if (lower.includes('connect.linux.do/login') || lower.includes('linux.do/login')) {
    return !loginType || loginType === 'linuxdo'
  }

  if (
    lower.includes('github.com/login/oauth/authorize') ||
    lower.includes('github.com/oauth/authorize') ||
    lower.includes('github.com/login') ||
    lower.includes('github.com/session')
  ) {
    return !loginType || loginType === 'github'
  }

  return lower.includes('/oauth2/authorize') ||
    lower.includes('/oauth2/approve') ||
    lower.includes('/oauth/authorize') ||
    lower.includes('/oauth/approve')
}

async function getAgentRouterLoginCandidateTabs(
  mainTab: chrome.tabs.Tab,
  origin: string,
  loginType: AgentRouterLoginType,
  trackedTabIds: Set<number>
): Promise<chrome.tabs.Tab[]> {
  const mainTabId = mainTab.id
  if (!mainTabId) return []

  const candidates: chrome.tabs.Tab[] = []
  const seen = new Set<number>()
  const addCandidate = (tab: chrome.tabs.Tab) => {
    if (!tab.id || seen.has(tab.id)) return
    seen.add(tab.id)
    candidates.push(tab)
  }

  addCandidate(mainTab)

  let tabs: chrome.tabs.Tab[] = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return candidates
  }

  for (const tab of tabs) {
    if (!tab.id || tab.id === mainTabId) continue
    const url = tab.url || ''
    const openedByTrackedTab = tab.openerTabId === mainTabId || (tab.openerTabId != null && trackedTabIds.has(tab.openerTabId))
    const sameWindow = mainTab.windowId == null || tab.windowId === mainTab.windowId
    const isOAuthTab = isAgentRouterOAuthUrl(url, loginType)
    const isTrackedTab = trackedTabIds.has(tab.id)

    if (openedByTrackedTab || (sameWindow && isOAuthTab)) {
      trackedTabIds.add(tab.id)
    }

    if (openedByTrackedTab || isTrackedTab || trackedTabIds.has(tab.id)) {
      addCandidate(tab)
      continue
    }

    if (sameWindow && isOAuthTab) {
      addCandidate(tab)
    } else if (sameWindow && trackedTabIds.has(tab.id) && url.startsWith(origin)) {
      addCandidate(tab)
    }
  }

  return candidates
}

async function waitForAgentRouterLogin(
  tabId: number,
  origin: string,
  loginType: AgentRouterLoginType,
  timeoutMs = 120000
): Promise<AgentRouterDomResult> {
  const deadline = Date.now() + timeoutMs
  let lastUrl = ''
  const trackedTabIds = new Set<number>()
  const authorizedTabIds = new Set<number>()
  const oauthFirstSeenAt = new Map<number, number>()
  let authorizeClickedAt: number | null = null
  let loginRetryCount = 0
  let lastAgentRouterTabId = tabId
  let lastAuthorizeResult: AgentRouterDomResult | null = null

  const isLinuxDoOAuthUrl = (url: string): boolean => {
    const lower = url.toLowerCase()
    return lower.includes('connect.linux.do')
  }

  const hasInvalidRequestFailure = (url: string, result?: AgentRouterDomResult | null): boolean => {
    const lowerUrl = url.toLowerCase()
    const body = (result?.body || '').toLowerCase()
    const message = (result?.message || '').toLowerCase()
    const error = (result?.error || '').toLowerCase()
    return lowerUrl.includes('invalid_request') ||
      body.includes('invalid_request') ||
      message.includes('invalid_request') ||
      error.includes('invalid_request')
  }

  const getRetryAgentRouterTabId = async (): Promise<number | null> => {
    if (await getTabSafe(lastAgentRouterTabId)) return lastAgentRouterTabId
    if (await getTabSafe(tabId)) return tabId
    return null
  }

  const retryAgentRouterLoginFromLoginPage = async (
    failedTabId: number,
    failedUrl: string,
    failure?: AgentRouterDomResult | null
  ): Promise<AgentRouterDomResult> => {
    const retryTabId = await getRetryAgentRouterTabId()

    if (failedTabId !== retryTabId && isLinuxDoOAuthUrl(failedUrl)) {
      await closeTabSafe(failedTabId)
      trackedTabIds.delete(failedTabId)
      authorizedTabIds.delete(failedTabId)
      oauthFirstSeenAt.delete(failedTabId)
    }

    if (loginRetryCount >= 1) {
      return failure || {
        state: 'failed',
        message: 'AgentRouter 登录失败',
        error: 'login_failed',
        body: failedUrl,
      }
    }

    if (!retryTabId) {
      return {
        state: 'failed',
        message: 'AgentRouter 登录标签页已关闭',
        error: 'tab_closed',
        body: failedUrl,
      }
    }

    if (failedTabId !== retryTabId && isLinuxDoOAuthUrl(failedUrl)) {
      await closeTabSafe(failedTabId)
      trackedTabIds.delete(failedTabId)
      authorizedTabIds.delete(failedTabId)
      oauthFirstSeenAt.delete(failedTabId)
    }

    return retryAgentRouterLogin(retryTabId)
  }

  const retryAgentRouterLogin = async (retryTabId: number): Promise<AgentRouterDomResult> => {
    loginRetryCount += 1
    authorizeClickedAt = null
    authorizedTabIds.clear()
    oauthFirstSeenAt.clear()
    trackedTabIds.add(retryTabId)

    await openAgentRouterLoginPage(retryTabId, origin, 45000)

    const retryBlocked = await runAgentRouterDomStep(retryTabId, 'detectBlocked', loginType)
    if (retryBlocked.state === 'blocked') return retryBlocked

    let retryLoginResult = await runAgentRouterDomStep(retryTabId, 'login', loginType)
    if (retryLoginResult.state === 'logged_out') {
      await openAgentRouterLoginPage(retryTabId, origin, 45000)
      retryLoginResult = await runAgentRouterDomStep(retryTabId, 'login', loginType)
    }
    return retryLoginResult
  }

  while (Date.now() < deadline) {
    const tab = await getTabSafe(tabId)
    if (!tab) {
      return { state: 'failed', message: 'AgentRouter 登录标签页已关闭', error: 'tab_closed' }
    }

    const candidateTabs = await getAgentRouterLoginCandidateTabs(tab, origin, loginType, trackedTabIds)
    const invalidRequestOAuthTab = candidateTabs.find(candidate => (
      !!candidate.id &&
      candidate.status === 'complete' &&
      isLinuxDoOAuthUrl(candidate.url || '') &&
      hasInvalidRequestFailure(candidate.url || '')
    ))
    if (invalidRequestOAuthTab?.id) {
      const failedUrl = invalidRequestOAuthTab.url || ''
      const retryLoginResult = await retryAgentRouterLoginFromLoginPage(invalidRequestOAuthTab.id, failedUrl, {
        state: 'failed',
        message: 'AgentRouter LinuxDO OAuth invalid_request，准备重试登录',
        error: 'login_failed',
        body: failedUrl,
      })
      if (retryLoginResult.state === 'blocked' || retryLoginResult.state === 'failed' || retryLoginResult.state === 'logged_in') {
        return retryLoginResult
      }

      await sleep(1500)
      continue
    }

    for (const candidateTab of candidateTabs) {
      if (!candidateTab.id) continue
      const candidateTabId = candidateTab.id
      const candidateUrl = candidateTab.url || ''
      lastUrl = candidateUrl || lastUrl
      const isAgentRouter = candidateUrl.startsWith(origin)
      const isOAuth = isAgentRouterOAuthUrl(candidateUrl, loginType)

      if (isAgentRouter && candidateTab.status === 'complete') {
        lastAgentRouterTabId = candidateTabId
        oauthFirstSeenAt.delete(candidateTabId)
        await sleep(1200)
        const authState = await runAgentRouterDomStep(candidateTabId, 'detectAuth', loginType)
        if (authState.state === 'blocked' || authState.state === 'logged_in') {
          return authState
        }
        if (authState.error === 'login_failed' && loginRetryCount >= 1) {
          return authState
        }

        const shouldRetryLogin = authState.state === 'failed' &&
          authorizeClickedAt != null &&
          loginRetryCount < 1 &&
          (
            authState.error === 'login_failed' ||
            authorizedTabIds.has(candidateTabId) ||
            Date.now() - authorizeClickedAt > 5000
          )

        if (shouldRetryLogin) {
          const retryLoginResult = await retryAgentRouterLogin(candidateTabId)
          if (retryLoginResult.state === 'blocked' || retryLoginResult.state === 'failed' || retryLoginResult.state === 'logged_in') {
            return retryLoginResult
          }

          await sleep(1500)
          continue
        }
      }

      if (isOAuth) {
        if (!oauthFirstSeenAt.has(candidateTabId)) {
          oauthFirstSeenAt.set(candidateTabId, Date.now())
        }
        if (candidateTab.status === 'complete') {
          if (isLinuxDoOAuthUrl(candidateUrl) && hasInvalidRequestFailure(candidateUrl)) {
            const retryLoginResult = await retryAgentRouterLoginFromLoginPage(candidateTabId, candidateUrl, {
              state: 'failed',
              message: 'AgentRouter LinuxDO OAuth invalid_request，准备重试登录',
              error: 'login_failed',
              body: candidateUrl,
            })
            if (retryLoginResult.state === 'blocked' || retryLoginResult.state === 'failed' || retryLoginResult.state === 'logged_in') {
              return retryLoginResult
            }

            await sleep(1500)
            continue
          }

          if (authorizedTabIds.has(candidateTabId)) {
            continue
          }

          await sleep(800)
          const authorizeResult = await runAgentRouterDomStep(candidateTabId, 'authorize', loginType)
          lastAuthorizeResult = authorizeResult

          if (authorizeResult.state === 'blocked') {
            return authorizeResult
          }

          if (isLinuxDoOAuthUrl(candidateUrl) && authorizeResult.error === 'login_failed' && hasInvalidRequestFailure(candidateUrl, authorizeResult)) {
            const retryLoginResult = await retryAgentRouterLoginFromLoginPage(candidateTabId, candidateUrl, authorizeResult)
            if (retryLoginResult.state === 'blocked' || retryLoginResult.state === 'failed' || retryLoginResult.state === 'logged_in') {
              return retryLoginResult
            }

            await sleep(1500)
            continue
          }

          if (authorizeResult.state === 'clicked') {
            authorizeClickedAt = Date.now()
            authorizedTabIds.add(candidateTabId)
            trackedTabIds.add(candidateTabId)
            await sleep(1800)
          } else if (Date.now() - (oauthFirstSeenAt.get(candidateTabId) || Date.now()) > 15000) {
            return {
              state: 'blocked',
              message: authorizeResult.message || 'OAuth 页面需要手动登录或授权',
              error: 'verification_blocked',
              body: authorizeResult.body || candidateUrl,
            }
          }
        }
      }
    }

    if (authorizeClickedAt != null && loginRetryCount < 1 && Date.now() - authorizeClickedAt > 12000) {
      const retryTabId = (await getTabSafe(lastAgentRouterTabId)) ? lastAgentRouterTabId : tabId
      const retryLoginResult = await retryAgentRouterLogin(retryTabId)
      if (retryLoginResult.state === 'blocked' || retryLoginResult.state === 'failed' || retryLoginResult.state === 'logged_in') {
        return retryLoginResult
      }
    }

    await sleep(1500)
  }

  return {
    state: 'blocked',
    message: `等待 ${loginType === 'github' ? 'GitHub' : 'LinuxDO'} OAuth 登录超时，请在打开的标签页中手动完成登录/验证`,
    error: 'verification_blocked',
    body: lastAuthorizeResult?.body || lastUrl,
  }
}

function agentRouterResultFromDom(result: AgentRouterDomResult): TestResult {
  if (result.state === 'success') {
    return {
      success: true,
      statusCode: 200,
      message: result.message,
      responseBody: result.body,
    }
  }

  const isBlocked = result.state === 'blocked' || result.error === 'verification_blocked'
  return {
    success: false,
    statusCode: 0,
    message: isBlocked ? 'AgentRouter 签到需要验证或人工处理' : result.message,
    error: isBlocked ? 'verification_blocked' : (result.error || result.message),
    responseBody: result.body,
  }
}

function agentRouterLoginSuccessResult(result: AgentRouterDomResult): TestResult {
  return {
    success: true,
    statusCode: 200,
    message: 'AgentRouter 登录成功，签到完成',
    responseBody: result.body,
  }
}

async function handleAgentRouterCheckin(site: Site): Promise<TestResult> {
  const loginType = site.agentRouterLoginType || 'linuxdo'
  const origin = new URL(AGENT_ROUTER_URL).origin
  let tabId: number | null = null

  try {
    await clearAgentRouterSiteData()

    const tab = await chrome.tabs.create({ url: AGENT_ROUTER_URL, active: true })
    if (!tab.id) throw new Error('Failed to create AgentRouter tab')
    tabId = tab.id

    await waitForTabComplete(tabId, 45000)
    await sleep(1500)

    await openAgentRouterLoginPage(tabId, origin, 45000)

    const initialBlocked = await runAgentRouterDomStep(tabId, 'detectBlocked', loginType)
    if (initialBlocked.state === 'blocked') return agentRouterResultFromDom(initialBlocked)

    let loginClickResult = await runAgentRouterDomStep(tabId, 'login', loginType)
    if (loginClickResult.state === 'logged_out') {
      await openAgentRouterLoginPage(tabId, origin, 45000)
      loginClickResult = await runAgentRouterDomStep(tabId, 'login', loginType)
    }
    if (loginClickResult.state === 'blocked' || loginClickResult.state === 'failed') {
      return agentRouterResultFromDom(loginClickResult)
    }

    if (loginClickResult.state === 'logged_in') {
      return agentRouterResultFromDom({
        state: 'failed',
        message: 'AgentRouter 未进入 OAuth 登录流程，已阻止使用旧登录状态直接判定成功',
        error: 'stale_login_state',
        body: loginClickResult.body,
      })
    }

    const loginResult = await waitForAgentRouterLogin(tabId, origin, loginType)
    if (loginResult.state === 'blocked' || loginResult.state === 'failed') {
      return agentRouterResultFromDom(loginResult)
    }

    await closeTabSafe(tabId)
    tabId = null
    return agentRouterLoginSuccessResult(loginResult)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AgentRouter checkin failed'
    if (tabId) await closeTabSafe(tabId)
    return { success: false, statusCode: 0, message, error: message }
  }
}

async function handleAgentRouterCheckinMessage(payload: { site: Site }): Promise<MessageResponse<import('../types').TestResult>> {
  const result = await handleAgentRouterCheckin(payload.site)
  return { success: true, data: result }
}

function responseToCheckinResult(response: MessageResponse<TestResult>, fallbackMessage: string): TestResult {
  if (response.success && response.data) return response.data
  const message = response.error || fallbackMessage
  return { success: false, statusCode: 0, message, error: message }
}

async function persistCheckinAttempt(site: Site, today: string, result: TestResult, isRetry: boolean) {
  const attempt = buildCheckinAttemptUpdate({
    site,
    result,
    today,
    nowMs: Date.now(),
    isRetry,
  })
  await updateSite(site.id, attempt.updates)
  if (attempt.shouldOpenVerificationTab) {
    try {
      await openVerificationTabOnce({ ...site, ...attempt.updates }, today)
    } catch (error) {
      console.error('[autoCheckin] Failed to open verification tab:', error)
    }
  }
}

async function persistUnexpectedCheckinFailure(site: Site, today: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'Checkin failed'
  const isRetry = site.checkinDate === today && !!site.checkinStatus && !isCheckinFinishedForToday(site, today)
  try {
    await persistCheckinAttempt(site, today, {
      success: false,
      statusCode: 0,
      message,
      error: message,
    }, isRetry)
  } catch (persistError) {
    console.error('[autoCheckin] Failed to persist check-in failure:', persistError)
  }
}

async function openVerificationTabOnce(site: Site, today: string) {
  const key = `${site.id}:${today}`
  if (verificationTabOpenKeys.has(key)) return
  verificationTabOpenKeys.add(key)

  const origin = site.siteType === 'agentrouter'
    ? new URL(AGENT_ROUTER_URL).origin
    : new URL(site.url.replace(/\/+$/, '')).origin
  const checkinPageUrl = site.siteType === 'bohe'
    ? origin
    : site.siteType === 'agentrouter'
      ? AGENT_ROUTER_URL
      : `${origin}/console/personal`
  if (site.siteType === 'agentrouter') {
    const existingTabs = await chrome.tabs.query({ url: `${origin}/*` })
    const existingTab = existingTabs.find(tab => tab.id)
    if (existingTab?.id) {
      await chrome.tabs.update(existingTab.id, { active: true })
      if (existingTab.windowId != null) {
        await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {})
      }
      return
    }
  }
  await chrome.tabs.create({ url: checkinPageUrl, active: true })
}

async function checkinSiteOnce(site: Site, today: string) {
  const isRetry = site.checkinDate === today && !!site.checkinStatus && !isCheckinFinishedForToday(site, today)

  if (site.siteType === 'anyrouter') {
    const result = await handleAnyRouterCheckin(site)
    await persistCheckinAttempt(site, today, result, isRetry)
    return
  }

  if (site.siteType === 'agentrouter') {
    const result = await handleAgentRouterCheckin(site)
    await persistCheckinAttempt(site, today, result, isRetry)
    return
  }

  if (site.siteType === 'bohe') {
    const attemptSite = isRetry ? { ...site, checkinTimeRange: undefined } : site
    const result = await handleBoheCheckin(attemptSite)
    await persistCheckinAttempt(site, today, result, isRetry)
    return
  }

  if (site.siteType === 'baibei') {
    const result = await handleBaibeiCheckin(site)
    await persistCheckinAttempt(site, today, result, isRetry)
    return
  }

  let lastResult: TestResult | null = null
  const attemptSite = isRetry ? { ...site, checkinTimeRange: undefined } : site

  if (site.accessToken) {
    const tokenResult = await handleCheckinSite({ site: attemptSite, manual: false })
    lastResult = responseToCheckinResult(tokenResult, 'Access token check-in failed')
    if (lastResult.success || lastResult.error === 'verification_blocked') {
      await persistCheckinAttempt(site, today, lastResult, isRetry)
      return
    }
  }

  if (site.cookie) {
    const cookieResult = await handleCheckinSite({ site: attemptSite, manual: false })
    lastResult = responseToCheckinResult(cookieResult, 'Cookie check-in failed')
  }

  if (!lastResult) {
    lastResult = {
      success: false,
      statusCode: 0,
      message: 'No access token or cookie available',
      error: 'No access token or cookie available',
    }
  }

  await persistCheckinAttempt(site, today, lastResult, isRetry)
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

      case 'CHECKIN_AGENTROUTER':
        return handleAgentRouterCheckinMessage(message.payload as { site: Site })

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

type SiteContextFetchResult = { ok: boolean; status: number; data: any; body?: string } | { error: string; body?: string }

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
          return { ok: res.ok, status: res.status, data, body: text, _diag: { hasSessionCookie: hasSession, cookieLength: docCookies.length, cookieNames: docCookies.split('; ').map(c => c.split('=')[0]).join(',') } }
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
    const autoSites = allSites.filter(s => s.enabled !== false && s.autoCheckin)
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
  if (site.enabled === false) {
    return { success: false, error: 'Site is disabled' }
  }
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

    if (site.siteType === 'bohe') {
      return { success: true, data: await handleBoheCheckin(site) }
    }

    if (site.siteType === 'baibei') {
      return { success: true, data: await handleBaibeiCheckin(site) }
    }

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
        checkinResult = { ok: response.ok, status: response.status, data, body: text }
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
          checkinResult = { ok: response.ok, status: response.status, data, body: text }
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
              checkinResult = { ok: response.ok, status: response.status, data, body: text }
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
          const isVerificationBlocked = isVerificationBlockedPayload({
            statusCode: checkinResult.status,
            message,
            data: parsed.data ?? checkinResult.data,
            responseBody: checkinResult.body,
          })
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
      const isVerificationBlocked = isVerificationBlockedPayload({
        statusCode: response.status,
        message,
        data: parsed.data,
        responseBody: text,
      })
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
