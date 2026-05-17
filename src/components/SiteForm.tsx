import React, { useState } from 'react'
import type { Site, SiteType, SiteAuthType, BalanceUnit, CheckinTimeRange } from '../types'
import { SITE_TYPE_OPTIONS } from '../types'

interface SiteFormProps {
  onSave: (data: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
  onSyncProvider?: (siteData: { name: string; url: string; authType: SiteAuthType; accessToken?: string; cookie?: string; userId?: string }) => void
  initialData?: Site
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

export function SiteForm({ onSave, onCancel, onSyncProvider, initialData }: SiteFormProps) {
  const [name, setName] = useState(initialData?.name || '')
  const [url, setUrl] = useState(initialData?.url || '')
  const [authType, setAuthType] = useState<SiteAuthType>(initialData?.authType || 'accessToken')
  const [accessToken, setAccessToken] = useState(initialData?.accessToken || '')
  const [cookie, setCookie] = useState(initialData?.cookie || '')
  const [userId, setUserId] = useState(initialData?.userId || '')
  const [siteType, setSiteType] = useState<SiteType>(initialData?.siteType || 'new-api')
  const [balanceUnit, setBalanceUnit] = useState<BalanceUnit>(initialData?.balanceUnit || 'usd')
  const [balanceCustomUnit, setBalanceCustomUnit] = useState(initialData?.balanceCustomUnit || '')
  const [autoCheckin, setAutoCheckin] = useState(initialData?.autoCheckin || false)
  const [autoRefreshCookie, setAutoRefreshCookie] = useState(initialData?.autoRefreshCookie ?? true)
  const [checkinTimeRange, setCheckinTimeRange] = useState<CheckinTimeRange>(initialData?.checkinTimeRange || { startHour: 6, endHour: 7 })
  const [showCheckinConfig, setShowCheckinConfig] = useState(!!initialData?.autoCheckin)
  const [showSecret, setShowSecret] = useState(false)
  const [fetchingUserId, setFetchingUserId] = useState(false)
  const [userIdError, setUserIdError] = useState('')
  const [syncingCookie, setSyncingCookie] = useState(false)
  const [cookieSyncError, setCookieSyncError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [syncingProvider, setSyncingProvider] = useState(false)
  const [syncProviderError, setSyncProviderError] = useState('')
  const [syncProviderSuccess, setSyncProviderSuccess] = useState(false)

  async function handleQuickImport() {
    setImporting(true)
    setImportError('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) {
        setImportError('无法获取当前标签页信息')
        setImporting(false)
        return
      }

      const urlObj = new URL(tab.url)
      const rootUrl = `${urlObj.protocol}//${urlObj.hostname}`

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const el = document.evaluate(
            '/html/body/div[1]/section/header/header/div/div/div[1]/a/div[2]/div/h4',
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue
          return el?.textContent?.trim() || ''
        },
      })
      const siteName = results?.[0]?.result || ''

      if (!siteName) {
        setImportError('未在当前页面找到站点名称，请确认页面结构')
        setImporting(false)
        return
      }

      setName(siteName)
      setUrl(rootUrl)

      const cookieRes = await new Promise<{ success: boolean; data?: string; error?: string }>(resolve => {
        chrome.runtime.sendMessage({ type: 'FETCH_BROWSER_COOKIES', payload: { url: rootUrl } }, resolve)
      })
      if (cookieRes.success && cookieRes.data) {
        setCookie(cookieRes.data)
        const userIdRes = await new Promise<{ success: boolean; data?: string; error?: string }>(resolve => {
          chrome.runtime.sendMessage({
            type: 'FETCH_SITE_USER_ID',
            payload: { siteUrl: rootUrl, cookie: cookieRes.data }
          }, resolve)
        })
        if (userIdRes.success && userIdRes.data) {
          setUserId(userIdRes.data)
        }
        const tokenRes = await new Promise<{ success: boolean; data?: string; error?: string }>(resolve => {
          chrome.runtime.sendMessage({
            type: 'FETCH_SYSTEM_ACCESS_TOKEN',
            payload: { siteUrl: rootUrl, cookie: cookieRes.data, userId: userIdRes.success ? userIdRes.data : undefined }
          }, resolve)
        })
        if (tokenRes.success && tokenRes.data) {
          setAccessToken(tokenRes.data)
        }
      } else {
        setImportError('站点名称和 URL 已导入，但 Cookie 获取失败，请手动同步')
      }
    } catch (e) {
      setImportError(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  async function handleSyncProvider() {
    if (!name.trim() || !url.trim()) {
      setSyncProviderError('请先填写站点名称和 URL')
      return
    }
    if (!onSyncProvider) return
    setSyncingProvider(true)
    setSyncProviderError('')
    setSyncProviderSuccess(false)
    try {
      await onSyncProvider({
        name: name.trim(),
        url: url.trim(),
        authType,
        accessToken: authType === 'accessToken' ? accessToken.trim() || undefined : undefined,
        cookie: authType === 'cookie' ? cookie.trim() || undefined : undefined,
        userId: userId.trim() || undefined,
      })
      setSyncProviderSuccess(true)
      setTimeout(() => setSyncProviderSuccess(false), 3000)
    } catch (e) {
      setSyncProviderError(e instanceof Error ? e.message : '同步 Provider 失败')
    } finally {
      setSyncingProvider(false)
    }
  }

  async function handleSyncCookie() {
    const siteUrl = url.trim()
    if (!siteUrl) {
      setCookieSyncError('请先填写 Site URL')
      return
    }
    setSyncingCookie(true)
    setCookieSyncError('')
    try {
      const cookieRes = await new Promise<{ success: boolean; data?: string; error?: string }>(resolve => {
        chrome.runtime.sendMessage({ type: 'FETCH_BROWSER_COOKIES', payload: { url: siteUrl } }, resolve)
      })
      if (!cookieRes.success || !cookieRes.data) {
        setCookieSyncError(cookieRes.error || '获取 Cookie 失败，请手动输入')
        setSyncingCookie(false)
        return
      }
      setCookie(cookieRes.data)
      const userIdRes = await new Promise<{ success: boolean; data?: string; error?: string }>(resolve => {
        chrome.runtime.sendMessage({
          type: 'FETCH_SITE_USER_ID',
          payload: { siteUrl, cookie: cookieRes.data, authType: 'cookie' }
        }, resolve)
      })
      if (userIdRes.success && userIdRes.data) {
        setUserId(userIdRes.data)
      } else {
        setCookieSyncError('Cookie 已同步，但 User ID 获取失败，请手动获取')
      }
    } catch (e) {
      setCookieSyncError(e instanceof Error ? e.message : '同步失败，请手动输入 Cookie')
    } finally {
      setSyncingCookie(false)
    }
  }

  async function handleFetchUserId() {
    const siteUrl = url.trim()
    if (!siteUrl) {
      setUserIdError('请先填写 Site URL')
      return
    }

    setFetchingUserId(true)
    setUserIdError('')

    if (authType === 'accessToken' && accessToken.trim()) {
      const jwtId = tryDecodeJwtUserId(accessToken.trim())
      if (jwtId) {
        setUserId(jwtId)
        setFetchingUserId(false)
        return
      }
    }

    try {
      const payload: { siteUrl: string; accessToken?: string; cookie?: string; authType: SiteAuthType } = {
        siteUrl,
        authType,
      }
      if (authType === 'accessToken' && accessToken.trim()) {
        payload.accessToken = accessToken.trim()
      }
      if (authType === 'cookie' && cookie.trim()) {
        payload.cookie = cookie.trim()
      }

      const response = await new Promise<{ success: boolean; data?: string; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_SITE_USER_ID', payload },
          resolve
        )
      })
      if (response.success && response.data) {
        setUserId(response.data)
      } else {
        setUserIdError(response.error || '获取 User ID 失败')
      }
    } catch (e) {
      setUserIdError(e instanceof Error ? e.message : '获取 User ID 失败')
    } finally {
      setFetchingUserId(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return

    const siteData: Omit<Site, 'id' | 'createdAt' | 'updatedAt'> = {
      name: name.trim(),
      url: url.trim(),
      authType,
      accessToken: accessToken.trim() || undefined,
      cookie: cookie.trim() || undefined,
      userId: userId.trim() || undefined,
      siteType,
      balanceUnit,
      balanceCustomUnit: balanceUnit === 'custom' ? (balanceCustomUnit.trim() || undefined) : undefined,
      autoCheckin,
      autoRefreshCookie,
      checkinTimeRange: autoCheckin ? (() => {
        const { startHour, endHour, scheduledMinute: existingMinute } = checkinTimeRange
        const totalMinutes = (endHour - startHour) * 60
        const scheduledMinute = existingMinute != null && existingMinute >= 0 && existingMinute < totalMinutes
          ? existingMinute
          : Math.floor(Math.random() * totalMinutes)
        return { startHour, endHour, scheduledMinute }
      })() : undefined,
    }

    onSave(siteData)
  }

  const hours = Array.from({ length: 25 }, (_, i) => i)

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
      {siteType === 'new-api' && (
      <div className="flex gap-1.5">
        <button type="button" onClick={handleQuickImport} disabled={importing}
          title="从当前浏览器标签页自动导入站点名称、URL 和 Cookie"
          className="flex-1 px-2.5 py-1.5 text-[11px] font-medium text-violet-600 bg-violet-50 rounded-lg hover:bg-violet-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1">
          {importing ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Importing...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
              一键导入
            </>
          )}
        </button>
        <button type="button" onClick={handleSyncProvider} disabled={syncingProvider || !name.trim() || !url.trim()}
          title="自动获取 API Token 并创建对应的 Provider（含分组和 API Key）"
          className="flex-1 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1">
          {syncingProvider ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Syncing...
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              同步Provider
            </>
          )}
        </button>
      </div>
      )}
      {siteType === 'new-api' && importError && <p className="text-[9px] text-amber-500">{importError}</p>}
      {siteType === 'new-api' && syncProviderError && <p className="text-[9px] text-amber-500">{syncProviderError}</p>}
      {syncProviderSuccess && <p className="text-[9px] text-emerald-500">Provider 同步成功</p>}

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Site Name</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
          placeholder="My Site" required />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Site Type</label>
        <select value={siteType} onChange={e => setSiteType(e.target.value as SiteType)}
          className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400">
          {SITE_TYPE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Site URL</label>
        <input type="url" value={url} onChange={e => setUrl(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
          placeholder="https://example.com" required />
      </div>

      {siteType !== 'anyrouter' ? (
      <>
      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">
          Access Token
          <span className="text-[9px] font-normal text-slate-400 ml-1">(system token, not sk- key)</span>
        </label>
        <div className="relative">
          <input type={showSecret ? 'text' : 'password'} value={accessToken} onChange={e => setAccessToken(e.target.value)}
            className="w-full px-2.5 py-1.5 pr-7 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 font-mono"
            placeholder="Paste from browser DevTools > Application > LocalStorage" />
          <button type="button" onClick={() => setShowSecret(!showSecret)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              {showSecret ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              )}
            </svg>
          </button>
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">
          Cookie
          <span className="text-[9px] font-normal text-slate-400 ml-1">(from browser DevTools &gt; Network &gt; Request Headers)</span>
        </label>
        <div className="flex gap-1.5 mb-1">
          <button type="button" onClick={handleSyncCookie} disabled={syncingCookie || !url.trim()}
            className="px-2 py-1.5 text-[10px] font-medium text-emerald-600 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap flex items-center gap-1">
            {syncingCookie ? (
              <>
                <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Syncing
              </>
            ) : (
              <>
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                Sync from Browser
              </>
            )}
          </button>
        </div>
        {cookieSyncError && <p className="mb-1 text-[9px] text-amber-500">{cookieSyncError}</p>}
        <div className="relative">
          <textarea value={cookie} onChange={e => { setCookie(e.target.value); setCookieSyncError('') }} rows={2}
            className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 font-mono resize-none"
            placeholder="Paste cookie string, or click Sync from Browser" />
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">
          User ID
          <span className="text-[9px] font-normal text-slate-400 ml-1">(签到必需)</span>
        </label>
        <div className="flex gap-1.5">
          <input type="text" value={userId} onChange={e => { setUserId(e.target.value); setUserIdError('') }}
            className="flex-1 px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 font-mono"
            placeholder="点击 Fetch 获取或手动输入" />
          <button type="button" onClick={handleFetchUserId} disabled={fetchingUserId}
            className="px-2 py-1.5 text-[10px] font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
            {fetchingUserId ? '...' : 'Fetch'}
          </button>
        </div>
        {userIdError && <p className="mt-0.5 text-[9px] text-red-500">{userIdError}</p>}
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">
          Balance Unit
          <span className="text-[9px] font-normal text-slate-400 ml-1">(how to display quota)</span>
        </label>
        <div className="flex gap-1">
          <button type="button" onClick={() => setBalanceUnit('usd')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
              balanceUnit === 'usd' ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}>
            USD
          </button>
          <button type="button" onClick={() => setBalanceUnit('cny')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
              balanceUnit === 'cny' ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}>
            CNY
          </button>
          <button type="button" onClick={() => setBalanceUnit('custom')}
            className={`flex-1 px-2 py-1.5 text-[10px] font-medium rounded-lg transition-colors ${
              balanceUnit === 'custom' ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}>
            Custom
          </button>
        </div>
        {balanceUnit === 'custom' && (
          <input type="text" value={balanceCustomUnit} onChange={e => setBalanceCustomUnit(e.target.value)}
            className="mt-1.5 w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
            placeholder="Currency symbol, e.g. €, £, HK$" />
        )}
      </div>
      </>
      ) : null}

      <div>
        <button type="button" onClick={() => setShowCheckinConfig(!showCheckinConfig)}
          className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 transition-colors">
          <svg className={`w-3 h-3 transition-transform ${showCheckinConfig ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          Auto Check-in
        </button>

        {showCheckinConfig && (
          <div className="mt-2 space-y-2.5 pl-2 border-l-2 border-blue-200">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500">Enable</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoCheckin}
                onClick={() => setAutoCheckin(!autoCheckin)}
                className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${autoCheckin ? 'bg-blue-500' : 'bg-slate-300'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${autoCheckin ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {siteType !== 'anyrouter' ? (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-500">Auto Refresh Cookie</span>
              <button
                type="button"
                role="switch"
                aria-checked={autoRefreshCookie}
                onClick={() => setAutoRefreshCookie(!autoRefreshCookie)}
                className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${autoRefreshCookie ? 'bg-blue-500' : 'bg-slate-300'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${autoRefreshCookie ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            ) : null}

            {autoCheckin && (
              <div>
                <label className="block text-[10px] text-slate-500 mb-1">
                  Time Range
                  <span className="text-[8px] text-slate-400 ml-1">(hours, 0-24)</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <select value={checkinTimeRange.startHour} onChange={e => setCheckinTimeRange(prev => ({ startHour: Number(e.target.value), endHour: prev.endHour }))}
                    className="flex-1 px-2 py-1 text-[10px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400">
                    {hours.map(h => <option key={h} value={h}>{h}:00</option>)}
                  </select>
                  <span className="text-[9px] text-slate-400">to</span>
                  <select value={checkinTimeRange.endHour} onChange={e => setCheckinTimeRange(prev => ({ startHour: prev.startHour, endHour: Number(e.target.value) }))}
                    className="flex-1 px-2 py-1 text-[10px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400">
                    {hours.map(h => <option key={h} value={h}>{h}:00</option>)}
                  </select>
                </div>
                {checkinTimeRange.scheduledMinute != null && (
                  <p className="mt-1 text-[8px] text-blue-400">
                    Scheduled at {checkinTimeRange.startHour + Math.floor(checkinTimeRange.scheduledMinute / 60)}:{String(checkinTimeRange.scheduledMinute % 60).padStart(2, '0')} (random, re-generated on save)
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      </div>

      <div className="shrink-0 flex gap-2 pt-2 pb-1 border-t border-slate-100 mt-2">
        <button type="button" onClick={onCancel}
          className="flex-1 px-3 py-1.5 text-[11px] font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          Cancel
        </button>
        <button type="submit"
          className="flex-1 px-3 py-1.5 text-[11px] font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors">
          {initialData ? 'Save' : 'Add Site'}
        </button>
      </div>
    </form>
  )
}
