import React, { useState, useEffect, useRef } from 'react'
import { CLIENT_PRESETS, DEFAULT_CLIENT_IDENTITY, type ClientIdentity, type ClientIdentitySettings, type ClientDisguiseSettings, type ClientPreset, PROVIDER_FORMAT_META } from '../utils/clientIdentity'
import type { Provider, RouterModelTestRequest, TestResult, ChatMessage, ChatSession, ExportData, Site, ModelEntry, ApiType, ProviderFormat, SiteAuthType } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { SiteForm } from '../components/SiteForm'
import { SiteCard } from '../components/SiteCard'
import { concreteApiTypes, selectedProtocol, defaultApiTypeForFormat, filterModelNamesForFormat, filterModelsForFormat, normalizeModelList } from '../utils/modelFormat'
import { projectRouterProvider, selectRouterProvider } from '../utils/routerProvider'
import { decodeBase64ApiKey } from '../utils/apiKey'
import { exportProviders, validateExportData } from '../utils/export'

function localDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.top = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      const ok = document.execCommand('copy')
      textarea.remove()
      return ok
    } catch {
      return false
    }
  }
}

interface FormatModelDraft {
  groupModels: Record<string, ModelEntry[]>
  testModel: string
}

function createEmptyFormatModelDrafts(): Record<ProviderFormat, FormatModelDraft> {
  return {
    openai: { groupModels: { default: [] }, testModel: '' },
    anthropic: { groupModels: { default: [] }, testModel: '' },
    deepseek: { groupModels: { default: [] }, testModel: '' },
  }
}

function createEmptyGroupModels(groupApiKeys: Record<string, string>, activeGroup: string): Record<string, ModelEntry[]> {
  const groups = new Set([...Object.keys(groupApiKeys), activeGroup, 'default'])
  return Object.fromEntries([...groups].map(group => [group, []]))
}

function normalizeGroupModelsForFormat(
  groupModels: Record<string, ModelEntry[]> | undefined,
  format: ProviderFormat,
  fallbackApiType: ApiType,
): Record<string, ModelEntry[]> {
  return Object.fromEntries(
    Object.entries(groupModels || { default: [] }).map(([group, models]) => [
      group,
      filterModelsForFormat(normalizeModelList(models, fallbackApiType, format), format),
    ])
  )
}

function normalizeModelsForFormat(
  models: Array<ModelEntry | string> | undefined,
  format: ProviderFormat,
  fallbackApiType: ApiType,
): ModelEntry[] {
  return filterModelsForFormat(normalizeModelList(models, fallbackApiType, format), format)
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [testingIds, setTestingIds] = useState<Set<string>>(() => new Set())
  const [testingAll, setTestingAll] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [editingRouterFormat, setEditingRouterFormat] = useState<ProviderFormat | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [providerTab, setProviderTab] = useState<ProviderFormat>('openai')
  const [routerClients, setRouterClients] = useState<Partial<Record<ProviderFormat, boolean>>>({})
  const [showRouterSettings, setShowRouterSettings] = useState(false)
  const [identityDraft, setIdentityDraft] = useState<ClientIdentitySettings>({ default: { ...DEFAULT_CLIENT_IDENTITY }, formatIdentities: {} })
  const [identityTab, setIdentityTab] = useState<'default' | 'openai' | 'anthropic' | 'deepseek'>('default')
  const [identityHeadersDraft, setIdentityHeadersDraft] = useState<Partial<Record<typeof identityTab, string>>>({})
  const [identityBusy, setIdentityBusy] = useState(false)
  const [identityNotice, setIdentityNotice] = useState<string | null>(null)
  const identityDraftRef = useRef(identityDraft)
  const identityRevision = useRef(0)
  const identitySaving = useRef(false)
  const identityPending = useRef<{ settings: ClientIdentitySettings; revision: number; scope: typeof identityTab } | null>(null)
  const identitySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const identityMounted = useRef(true)
  const [disguiseDraft, setDisguiseDraft] = useState<ClientDisguiseSettings>({})
  const [disguiseTab, setDisguiseTab] = useState<ProviderFormat>('openai')
  const [disguiseHeadersDraft, setDisguiseHeadersDraft] = useState<Partial<Record<ProviderFormat, string>>>({})
  const [disguiseBusy, setDisguiseBusy] = useState(false)
  const [disguiseNotice, setDisguiseNotice] = useState<string | null>(null)
  const disguiseDraftRef = useRef(disguiseDraft)
  const disguiseRevision = useRef(0)
  const disguiseSaving = useRef(false)
  const disguisePending = useRef<{ settings: ClientDisguiseSettings; revision: number } | null>(null)
  const disguiseSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disguiseMounted = useRef(true)
  const ENTRY_CLIENT_META: Record<ProviderFormat, { label: string; hint: string }> = {
    openai: { label: 'Codex CLI', hint: '/openai' },
    anthropic: { label: 'Claude Code', hint: '/anthropic' },
    deepseek: { label: 'DeepSeek Harness', hint: '/deepseek' },
  }
  const tabActiveProvider = (format: ProviderFormat) => routerClients[format]
    ? selectRouterProvider(providers, format)
    : providers.find(provider => provider.isActive && (provider.format || 'openai') === format)
  const activeProvider = tabActiveProvider(providerTab) || null

  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)

  const [formName, setFormName] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formModels, setFormModels] = useState<ModelEntry[]>([])
  const [formNewModel, setFormNewModel] = useState('')
  const [formNewModelApiType, setFormNewModelApiType] = useState<ApiType>('both')
  const [formModelFilter, setFormModelFilter] = useState<ApiType | 'any'>('any')
  const [formModelSearch, setFormModelSearch] = useState('')
  const [editingModelName, setEditingModelName] = useState<string | null>(null)
  const [editingModelValue, setEditingModelValue] = useState('')
  const [formTestModel, setFormTestModel] = useState<string>('')
  const [formApiType, setFormApiType] = useState<ApiType>('both')
  const [formFormat, setFormFormat] = useState<ProviderFormat>('openai')
  const [formFormatConversionEnabled, setFormFormatConversionEnabled] = useState(false)
  const [formGroupApiKeys, setFormGroupApiKeys] = useState<Record<string, string>>({ default: '' })
  const [formGroupModels, setFormGroupModels] = useState<Record<string, ModelEntry[]>>({ default: [] })
  const [formatModelDrafts, setFormatModelDrafts] = useState<Record<ProviderFormat, FormatModelDraft>>(createEmptyFormatModelDrafts)
  const [formActiveGroup, setFormActiveGroup] = useState('default')
  const [groupEditing, setGroupEditing] = useState(false)
  const [groupNewName, setGroupNewName] = useState('')
  const [groupRenaming, setGroupRenaming] = useState(false)
  const [groupRenameValue, setGroupRenameValue] = useState('')
  const [groupRenamingTarget, setGroupRenamingTarget] = useState('')
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formTesting, setFormTesting] = useState(false)
  const [formTestViaRouter, setFormTestViaRouter] = useState(false)
  const [formTestResult, setFormTestResult] = useState<TestResult | null>(null)
  const [expandedEndpoint, setExpandedEndpoint] = useState<string | null>(null)
  const [syncingModels, setSyncingModels] = useState(false)
  const [syncModelsError, setSyncModelsError] = useState<string | null>(null)
  const formTestUsesRouter = editingRouterFormat !== null || formTestViaRouter
  const routerTestModels = editingProvider
    ? editingProvider.groupModels?.[editingProvider.activeGroup || 'default']
      || editingProvider.formatGroupModels?.[editingProvider.format || 'openai']?.[editingProvider.activeGroup || 'default']
      || editingProvider.models
      || (editingProvider.model ? [{ name: editingProvider.model, apiType: editingProvider.apiType, format: editingProvider.format }] : [])
    : []

  const [chatProviderId, setChatProviderId] = useState<string>('')
  const [chatModel, setChatModel] = useState<string>('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatStreaming, setChatStreaming] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatAttachment, setChatAttachment] = useState<{ name: string; content: string; type: string } | null>(null)
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSessionList, setShowSessionList] = useState(false)
  const [syncEnabled, setSyncEnabled] = useState(true)
  const [routerEnabled, setRouterEnabled] = useState(false)
  const [routerRunning, setRouterRunning] = useState(false)
  const [routerPort, setRouterPort] = useState(15721)
  const [routerProxy, setRouterProxy] = useState('')
  const [routerBusy, setRouterBusy] = useState(false)
  const [conversionUpdatingId, setConversionUpdatingId] = useState<string | null>(null)
  const [providerDeleteBusy, setProviderDeleteBusy] = useState(false)
  const routerAvailable = routerEnabled && routerRunning
  const routingBusy = routerBusy || conversionUpdatingId !== null || providerDeleteBusy || saving
  const [chatProviderDropdownOpen, setChatProviderDropdownOpen] = useState(false)
  const [chatModelDropdownOpen, setChatModelDropdownOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [checkinExpanded, setCheckinExpanded] = useState(false)
  const [checkinTab, setCheckinTab] = useState<'enabled' | 'disabled'>('enabled')
  const pendingCheckinDone = useRef(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverTab, setDragOverTab] = useState<ProviderFormat | null>(null)
  const [siteDragId, setSiteDragId] = useState<string | null>(null)
  const [siteDragOverId, setSiteDragOverId] = useState<string | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [siteManageMode, setSiteManageMode] = useState(false)
  const [selectedSiteIds, setSelectedSiteIds] = useState<string[]>([])
  const [addingSite, setAddingSite] = useState(false)
  const [editingSite, setEditingSite] = useState<Site | null>(null)
  const [testingSiteId, setTestingSiteId] = useState<string | null>(null)
  const [checkingInSiteId, setCheckingInSiteId] = useState<string | null>(null)
  const [checkingInAll, setCheckingInAll] = useState(false)
  const [refreshingSiteId, setRefreshingSiteId] = useState<string | null>(null)
  const [, setRefreshingBalances] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [webhookTesting, setWebhookTesting] = useState(false)
  const [webhookTestResult, setWebhookTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [providerImporting, setProviderImporting] = useState(false)
  const [providerImportError, setProviderImportError] = useState('')
  const [clipboardImporting, setClipboardImporting] = useState(false)
  const [sharedProviderId, setSharedProviderId] = useState<string | null>(null)

  const dropdownRef = useRef<HTMLDivElement>(null)
  const groupDropdownRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const chatProviderDropdownRef = useRef<HTMLDivElement>(null)
  const chatModelDropdownRef = useRef<HTMLDivElement>(null)
  const siteListRef = useRef<HTMLDivElement>(null)
  const siteListScrollPos = useRef(0)

  useEffect(() => {
    if (!addingSite && !editingSite && siteListRef.current) {
      siteListRef.current.scrollTop = siteListScrollPos.current
    }
  }, [addingSite, editingSite])

  useEffect(() => { loadProviders(); refreshBalances() }, [])

  useEffect(() => {
    async function loadSyncState() {
      const res = await chrome.storage.local.get(['sync_enabled', 'webhook_url', 'webhook_enabled', 'router_port', 'routerProxy'])
      setSyncEnabled(res.sync_enabled !== false)
      setWebhookUrl(res.webhook_url || '')
      setWebhookEnabled(res.webhook_enabled || false)
      setRouterPort(Number(res.router_port) || 15721)
      setRouterProxy(typeof res.routerProxy === 'string' ? res.routerProxy : '')
      const status = await sendMessage<{ success: boolean; data?: { enabled: boolean; running: boolean; port?: number; proxyUrl?: string; clients?: Partial<Record<ProviderFormat, boolean>> } }>('GET_ROUTER_STATUS')
      if (status.success && status.data) {
        setRouterClients(status.data.clients || {})
        setRouterEnabled(status.data.enabled)
        setRouterRunning(status.data.running)
        if (status.data.port) setRouterPort(status.data.port)
        if (typeof status.data.proxyUrl === 'string') setRouterProxy(status.data.proxyUrl)
      }
    }
    loadSyncState()
  }, [])

  useEffect(() => {
    setSelectedIds(new Set())
    setOpenDropdownId(null)
    setDragId(null)
    setDragOverId(null)
  }, [routerAvailable])

  const groupOptions = Object.keys(formGroupApiKeys).sort()

  useEffect(() => {
    async function loadChatSessions() {
      const res = await sendMessage<{ success: boolean; data: { sessions: ChatSession[]; activeId: string | null } }>('GET_CHAT_SESSIONS')
      if (res.success && res.data) {
        setChatSessions(res.data.sessions)
        setActiveSessionId(res.data.activeId)
        if (res.data.activeId) {
          const active = res.data.sessions.find(s => s.id === res.data.activeId)
          if (active) {
            setChatProviderId(active.providerId)
            setChatModel(active.model)
            setChatMessages(active.messages)
          }
        }
      }
    }
    loadChatSessions()
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdownId(null)
      }
      if (chatProviderDropdownRef.current && !chatProviderDropdownRef.current.contains(e.target as Node)) {
        setChatProviderDropdownOpen(false)
      }
      if (chatModelDropdownRef.current && !chatModelDropdownRef.current.contains(e.target as Node)) {
        setChatModelDropdownOpen(false)
      }
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node)) {
        setGroupDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    if (chatMessages.length > 0 && chatProviderId && chatModel && activeSessionId) {
      sendMessage('SAVE_CHAT_SESSION', { id: activeSessionId, providerId: chatProviderId, model: chatModel, messages: chatMessages })
    }
  }, [chatMessages, chatProviderId, chatModel, activeSessionId])

  useEffect(() => {
    if (providers.length > 0 && !chatProviderId) {
      const active = providers.find(p => p.isActive) || providers[0]
      setChatProviderId(active.id)
      setChatModel(active.model)
    }
  }, [providers, chatProviderId])

  async function loadProviders() {
    const res = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (res.success) {
      const list = res.data.map(p => {
        const format = p.format || 'openai'
        const fallbackApiType = p.apiType || defaultApiTypeForFormat(format)
        const allModels = filterModelsForFormat(
          normalizeModelList(
            Array.isArray(p.models) && p.models.length > 0
              ? p.models
              : (p.model ? [{ name: p.model, apiType: fallbackApiType, format }] : []),
            fallbackApiType,
            format
          ),
          format
        )
        const gm = normalizeGroupModelsForFormat(p.groupModels || { default: allModels }, format, fallbackApiType)
        const ag = p.activeGroup || 'default'
        const activeModels = gm[ag] || allModels
        const currentModel = p.model || activeModels[0]?.name
        const modelExists = activeModels.some(m => m.name === currentModel)
        return {
          ...p,
          format,
          models: activeModels,
          model: modelExists ? currentModel : (activeModels[0]?.name || p.model),
          groupModels: gm,
        }
      })
      setProviders(list)
    }
  }

  async function refreshBalances() {
    const sitesRes = await sendMessage<{ success: boolean; data: Site[] }>('GET_SITES')
    if (!sitesRes.success || !sitesRes.data) return
    const sites = sitesRes.data
    const provRes = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (!provRes.success || !provRes.data) return
    const providers = provRes.data

    for (const site of sites) {
      if (site.authType !== 'cookie' && !site.accessToken) continue
      if (!site.providerId) continue
      const provider = providers.find(p => p.id === site.providerId)
      if (!provider) continue

      const balanceRes = await sendMessage<{ success: boolean; data: string }>('FETCH_SITE_BALANCE', {
        url: site.url,
        accessToken: site.accessToken,
        cookie: site.cookie,
        userId: site.userId,
        authType: site.authType,
        balanceUnit: site.balanceUnit,
        balanceCustomUnit: site.balanceCustomUnit,
      })
      if (balanceRes.success && balanceRes.data) {
        await sendMessage('UPDATE_PROVIDER', { id: provider.id, updates: { balance: balanceRes.data } })
        setProviders(prev => prev.map(p => p.id === provider.id ? { ...p, balance: balanceRes.data } : p))
      }
    }
  }

  async function loadSites() {
    const res = await sendMessage<{ success: boolean; data: Site[] }>('GET_SITES')
    if (res.success) {
      const today = localDateStr()
      const list = (Array.isArray(res.data) ? res.data : []).map(s => {
        if (s.checkinStatus && s.checkinDate !== today) {
          return { ...s, checkinStatus: undefined, checkinDate: undefined }
        }
        return s
      })
      setSites(list)
    }
  }

  async function refreshAllBalances() {
    setRefreshingBalances(true)
    await sendMessage('REFRESH_ALL_BALANCES')
    await Promise.all([loadSites(), loadProviders()])
    setRefreshingBalances(false)
  }

  async function refreshSiteBalance(siteId: string) {
    setRefreshingSiteId(siteId)
    const site = sites.find(s => s.id === siteId)
    if (!site) return
    const res = await sendMessage<{ success: boolean; data: string }>('FETCH_SITE_BALANCE', {
      url: site.url,
      accessToken: site.accessToken,
      cookie: site.cookie,
      userId: site.userId,
      authType: site.authType,
      balanceUnit: site.balanceUnit,
      balanceCustomUnit: site.balanceCustomUnit,
    })
    if (res.success && res.data) {
      await sendMessage('UPDATE_SITE', { id: siteId, updates: { balance: res.data } })
      setSites(prev => prev.map(s => s.id === siteId ? { ...s, balance: res.data } : s))
      if (site.providerId) {
        await sendMessage('UPDATE_PROVIDER', { id: site.providerId, updates: { balance: res.data } })
        setProviders(prev => prev.map(p => p.id === site.providerId ? { ...p, balance: res.data } : p))
      }
    }
    setRefreshingSiteId(null)
  }

  useEffect(() => {
    loadSites().then(() => {
      refreshAllBalances()
      if (!pendingCheckinDone.current) {
        pendingCheckinDone.current = true
        sendMessage('PERFORM_PENDING_CHECKIN')
      }
    })
  }, [])

  async function handleCheckinAll() {
    setCheckingInAll(true)
    const today = localDateStr()
    const eligible = sites.filter(s => s.enabled !== false && s.autoCheckin && !(s.checkinDate === today && s.checkinStatus?.isSuccess))
    await Promise.all(eligible.map(site => handleCheckinSite(site, true)))
    setCheckingInAll(false)
    if (webhookEnabled && webhookUrl) {
      await sendMessage('SEND_WEBHOOK', { sites, today })
    }
  }

  async function handleToggleSiteEnabled(site: Site) {
    const enabled = site.enabled === false
    const updates = { enabled, autoCheckin: enabled }
    const res = await sendMessage<{ success: boolean; error?: string }>('UPDATE_SITE', { id: site.id, updates })
    if (res.success) {
      setSites(prev => prev.map(item => item.id === site.id ? { ...item, ...updates } : item))
    } else if (res.error) {
      alert(`更新站点状态失败：${res.error}`)
    }
  }

  function toggleSiteSelection(id: string) {
    setSelectedSiteIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
  }

  async function handleBulkSiteAction(action: 'enable' | 'disable' | 'delete') {
    const selected = sites.filter(site => selectedSiteIds.includes(site.id))
    if (!selected.length) return

    if (action === 'delete' && !window.confirm(`确定移除选中的 ${selected.length} 个站点吗？`)) return

    if (action === 'delete') {
      const results = await Promise.all(selected.map(site => sendMessage<{ success: boolean }>('DELETE_SITE', site.id)))
      if (results.some(result => !result.success)) {
        await loadSites()
      } else {
        setSites(prev => prev.filter(site => !selectedSiteIds.includes(site.id)))
      }
    } else {
      const enabled = action === 'enable'
      const updates = { enabled, autoCheckin: enabled }
      const results = await Promise.all(selected.map(site => sendMessage<{ success: boolean }>('UPDATE_SITE', { id: site.id, updates })))
      if (results.some(result => !result.success)) {
        await loadSites()
      } else {
        setSites(prev => prev.map(site => selectedSiteIds.includes(site.id) ? { ...site, ...updates } : site))
      }
    }
    setSelectedSiteIds([])
  }

  async function handleAddSite(data: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>) {
    const res = await sendMessage<{ success: boolean; data: Site }>('ADD_SITE', data)
    if (res.success) {
      setSites(prev => [...prev, res.data!])
      setAddingSite(false)
    }
  }

  async function handleUpdateSite(data: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>) {
    if (!editingSite) return
    const res = await sendMessage<{ success: boolean }>('UPDATE_SITE', { id: editingSite.id, updates: data })
    if (res.success) {
      setSites(prev => prev.map(s => s.id === editingSite.id ? { ...s, ...data } : s))
      setEditingSite(null)
    }
  }

  async function handleSyncProvider(siteData: { name: string; url: string; authType: SiteAuthType; accessToken?: string; cookie?: string; userId?: string }) {
    const baseUrl = siteData.url.replace(/\/+$/, '') + '/v1'

    let tokenInfoRes = await sendMessage<{ success: boolean; data?: Array<{ id: number; group: string }>; error?: string }>('FETCH_SITE_TOKEN_INFO', {
      url: siteData.url,
      accessToken: siteData.accessToken,
      cookie: siteData.cookie,
      userId: siteData.userId,
      authType: siteData.authType,
    })

    // No tokens found, create one then retry
    if (!tokenInfoRes.success || !tokenInfoRes.data || tokenInfoRes.data.length === 0) {
      const createRes = await sendMessage<{ success: boolean; data?: boolean; error?: string }>('CREATE_SITE_TOKEN', {
        url: siteData.url,
        cookie: siteData.cookie,
        userId: siteData.userId,
        name: siteData.name,
      })

      if (createRes.success) {
        // Retry fetching token info after creation
        tokenInfoRes = await sendMessage<{ success: boolean; data?: Array<{ id: number; group: string }>; error?: string }>('FETCH_SITE_TOKEN_INFO', {
          url: siteData.url,
          accessToken: siteData.accessToken,
          cookie: siteData.cookie,
          userId: siteData.userId,
          authType: siteData.authType,
        })
        if (!tokenInfoRes.success || !tokenInfoRes.data || tokenInfoRes.data.length === 0) {
          throw new Error(`创建令牌成功但获取令牌信息失败: ${tokenInfoRes.error || 'unknown'}`)
        }
      } else {
        throw new Error(`获取令牌信息失败且自动创建令牌失败: ${tokenInfoRes.error || 'unknown'} / ${createRes.error || 'unknown'}`)
      }
    }

    const groupApiKeys: Record<string, string> = {}
    let firstApiKey = ''
    let firstGroup = 'default'

    for (const token of tokenInfoRes.data) {
      const tokenKeyRes = await sendMessage<{ success: boolean; data?: string; error?: string }>('FETCH_SITE_TOKEN_KEY', {
        url: siteData.url,
        tokenId: token.id,
        accessToken: siteData.accessToken,
        cookie: siteData.cookie,
        userId: siteData.userId,
        authType: siteData.authType,
      })
      if (tokenKeyRes.success && tokenKeyRes.data) {
        const groupName = token.group || 'default'
        groupApiKeys[groupName] = tokenKeyRes.data
        if (!firstApiKey) {
          firstApiKey = tokenKeyRes.data
          firstGroup = groupName
        }
      }
    }

    if (!firstApiKey) {
      throw new Error('获取令牌密钥失败')
    }

    const providerRes = await sendMessage<{ success: boolean; data: Provider }>('ADD_PROVIDER', {
      name: siteData.name,
      baseUrl,
      apiKey: firstApiKey,
      model: '',
      models: [],
      apiType: 'both' as ApiType,
      format: 'openai' as ProviderFormat,
      groupApiKeys,
      activeGroup: firstGroup,
      isActive: false,
    })

    if (!providerRes.success || !providerRes.data) {
      throw new Error('创建 Provider 失败')
    }

    setProviders(prev => [...prev, providerRes.data!])
  }

  async function handleTestSite(site: Site) {
    setTestingSiteId(site.id)
    const res = await sendMessage<{ success: boolean; data: TestResult }>('TEST_SITE', site)
    if (res.success && res.data) {
      setSites(prev => prev.map(s =>
        s.id === site.id ? { ...s, testStatus: { lastTestTime: Date.now(), isSuccess: res.data!.success, statusCode: res.data!.statusCode, errorMessage: res.data!.error, responseBody: res.data!.responseBody } } : s
      ))
    }
    setTestingSiteId(null)
  }

  async function handleCheckinSite(site: Site, manual = true) {
    setCheckingInSiteId(site.id)

    const today = localDateStr()

    if (site.siteType === 'anyrouter' || site.siteType === 'agentrouter') {
      const messageType = site.siteType === 'agentrouter' ? 'CHECKIN_AGENTROUTER' : 'CHECKIN_ANYROUTER'
      const res = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>(messageType, { site })
      const data = res.data
      const status = {
        lastTestTime: Date.now(),
        isSuccess: !!(res.success && data?.success),
        statusCode: data?.statusCode,
        errorMessage: data?.error || res.error,
        responseBody: data?.responseBody,
      }
      setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
      await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
      setCheckingInSiteId(null)
      return
    }

    if (site.siteType === 'bohe' || site.siteType === 'baibei') {
      const res = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>('CHECKIN_SITE', { site, manual })
      const data = res.data
      const status = {
        lastTestTime: Date.now(),
        isSuccess: !!(res.success && data?.success),
        statusCode: data?.statusCode,
        errorMessage: data?.error || res.error,
        responseBody: data?.responseBody,
      }
      setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
      await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
      setCheckingInSiteId(null)
      return
    }

    if (site.accessToken) {
      const tokenRes = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>('CHECKIN_SITE', {
        site: { ...site, authType: 'accessToken' as const },
        manual,
      })
      if (tokenRes.success && tokenRes.data?.success) {
        const status = { lastTestTime: Date.now(), isSuccess: true, statusCode: tokenRes.data.statusCode, errorMessage: tokenRes.data.error, responseBody: tokenRes.data.responseBody }
        setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
        await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
        setCheckingInSiteId(null)
        return
      }
    }

    if (site.cookie) {
      const cookieRes = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>('CHECKIN_SITE', {
        site: { ...site, authType: 'cookie' as const },
        manual,
      })
      if (cookieRes.success && cookieRes.data) {
        const status = { lastTestTime: Date.now(), isSuccess: cookieRes.data.success, statusCode: cookieRes.data.statusCode, errorMessage: cookieRes.data.error, responseBody: cookieRes.data.responseBody }
        setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
        await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
      } else if (cookieRes.error) {
        const status = { lastTestTime: Date.now(), isSuccess: false, errorMessage: cookieRes.error }
        setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
        await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
      }
    } else if (!site.accessToken) {
      const status = { lastTestTime: Date.now(), isSuccess: false, errorMessage: 'No access token or cookie available' }
      setSites(prev => prev.map(s => s.id === site.id ? { ...s, checkinStatus: status, checkinDate: today } : s))
      await sendMessage('UPDATE_SITE', { id: site.id, updates: { checkinStatus: status, checkinDate: today } })
    }

    setCheckingInSiteId(null)
  }

  async function handleDeleteSite(id: string) {
    await sendMessage('DELETE_SITE', id)
    setSites(prev => prev.filter(s => s.id !== id))
  }

  async function handleSetActive(id: string, targetFormat: ProviderFormat, viaRouter = false) {
    if (selectMode || routingBusy) return
    if (viaRouter && (!routerAvailable || providers.find(provider => provider.id === id)?.formatConversionEnabled !== true)) return
    const res = await sendMessage<{ success: boolean; error?: string }>('SET_ACTIVE_PROVIDER', { id, sync: syncEnabled, ...(routerEnabled || viaRouter ? { targetFormat } : {}) })
    await loadProviders()
    if (!res.success) {
      alert(`Could not activate provider: ${res.error || 'Unknown error'}`)
    }
  }

  async function handleToggleFormatConversion(provider: Provider) {
    if (selectMode || routingBusy) return
    setConversionUpdatingId(provider.id)
    try {
      const res = await sendMessage<{ success: boolean; error?: string }>('UPDATE_PROVIDER', {
        id: provider.id,
        updates: { formatConversionEnabled: provider.formatConversionEnabled !== true },
      })
      if (!res.success) {
        alert(`Could not update format conversion: ${res.error || 'Unknown error'}`)
        return
      }
      await loadProviders()
      setSelectedIds(new Set())
      setOpenDropdownId(null)
      setDragId(null)
      setDragOverId(null)
    } catch (error) {
      alert(`Could not update format conversion: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setConversionUpdatingId(null)
    }
  }

  async function handleToggleSync() {
    const newVal = !syncEnabled
    setSyncEnabled(newVal)
    await chrome.storage.local.set({ sync_enabled: newVal })
  }

  useEffect(() => {
    if (!showRouterSettings || identitySaving.current || identityPending.current || identitySaveTimer.current !== null) return
    let cancelled = false
    const revision = identityRevision.current
    void (async () => {
      try {
        const res = await sendMessage<{ success: boolean; data?: ClientIdentitySettings; error?: string }>('GET_CLIENT_IDENTITY')
        if (cancelled || revision !== identityRevision.current) return
        if (!res.success || !res.data) {
          setIdentityNotice(res.error || '读取浏览器伪装失败')
          return
        }
        identityDraftRef.current = res.data
        setIdentityDraft(res.data)
        setIdentityHeadersDraft({})
      } catch (error) {
        if (!cancelled && revision === identityRevision.current) {
          setIdentityNotice(error instanceof Error ? error.message : '读取浏览器伪装失败')
        }
      }
    })()
    return () => { cancelled = true }
  }, [showRouterSettings])

  useEffect(() => {
    identityMounted.current = true
    return () => {
      identityMounted.current = false
      // A popup may close before the text debounce expires; still persist its last edit.
      if (identitySaveTimer.current !== null) void handleSaveClientIdentity()
    }
  }, [])

  async function handleSaveClientIdentity() {
    if (identitySaveTimer.current !== null) {
      clearTimeout(identitySaveTimer.current)
      identitySaveTimer.current = null
    }
    identityPending.current = { settings: identityDraftRef.current, revision: identityRevision.current, scope: identityTab }
    if (identitySaving.current) return
    identitySaving.current = true
    if (identityMounted.current) {
      setIdentityBusy(true)
      setIdentityNotice(null)
    }
    try {
      // Coalesce pending snapshots, but never drop edits while an older request is running.
      while (identityPending.current) {
        const request = identityPending.current
        identityPending.current = null
        try {
          const res = await sendMessage<{ success: boolean; data?: ClientIdentitySettings; error?: string }>('SET_CLIENT_IDENTITY', request.settings)
          if (!identityMounted.current || request.revision !== identityRevision.current) continue
          if (!res.success) {
            setIdentityNotice(res.error || '保存失败')
            continue
          }
          const saved = res.data || request.settings
          identityDraftRef.current = saved
          setIdentityDraft(saved)
          const active = request.scope === 'default' ? saved.default : saved.formatIdentities[request.scope] || saved.default
          setIdentityNotice(active.preset === 'off' ? '已关闭浏览器伪装' : '已应用浏览器伪装')
        } catch (error) {
          if (identityMounted.current && request.revision === identityRevision.current) {
            setIdentityNotice(error instanceof Error ? error.message : '保存失败')
          }
        }
      }
    } finally {
      identitySaving.current = false
      if (identityMounted.current) setIdentityBusy(false)
    }
  }

  /** Draft for the currently selected scope; falls back to the global default. */
  const activeIdentityDraft: ClientIdentity = identityTab === 'default'
    ? identityDraft.default
    : identityDraft.formatIdentities[identityTab] || identityDraft.default

  function updateActiveIdentity(patch: Partial<ClientIdentity>, immediate = false) {
    const current = identityDraftRef.current
    const active = identityTab === 'default' ? current.default : current.formatIdentities[identityTab] || current.default
    const next = identityTab === 'default'
      ? { ...current, default: { ...active, ...patch } }
      : { ...current, formatIdentities: { ...current.formatIdentities, [identityTab]: { ...active, ...patch } } }
    identityDraftRef.current = next
    identityRevision.current += 1
    setIdentityDraft(next)
    setIdentityNotice(null)
    if (identitySaveTimer.current !== null) clearTimeout(identitySaveTimer.current)
    if (immediate) void handleSaveClientIdentity()
    else identitySaveTimer.current = setTimeout(() => void handleSaveClientIdentity(), 250)
  }

  function resetActiveIdentity() {
    if (identityTab === 'default') return
    const nextFormats = { ...identityDraftRef.current.formatIdentities }
    delete nextFormats[identityTab]
    const next = { ...identityDraftRef.current, formatIdentities: nextFormats }
    identityDraftRef.current = next
    identityRevision.current += 1
    setIdentityDraft(next)
    setIdentityHeadersDraft(current => {
      const next = { ...current }
      delete next[identityTab]
      return next
    })
    void handleSaveClientIdentity()
  }

  useEffect(() => {
    if (!showRouterSettings || disguiseSaving.current || disguisePending.current || disguiseSaveTimer.current !== null) return
    let cancelled = false
    const revision = disguiseRevision.current
    void (async () => {
      try {
        const res = await sendMessage<{ success: boolean; data?: ClientDisguiseSettings; error?: string }>('GET_CLIENT_DISGUISE')
        if (cancelled || revision !== disguiseRevision.current) return
        if (!res.success || !res.data) {
          setDisguiseNotice(res.error || '读取客户端伪装失败')
          return
        }
        disguiseDraftRef.current = res.data
        setDisguiseDraft(res.data)
        setDisguiseHeadersDraft({})
      } catch (error) {
        if (!cancelled && revision === disguiseRevision.current) {
          setDisguiseNotice(error instanceof Error ? error.message : '读取客户端伪装失败')
        }
      }
    })()
    return () => { cancelled = true }
  }, [showRouterSettings])

  useEffect(() => {
    disguiseMounted.current = true
    return () => {
      disguiseMounted.current = false
      if (disguiseSaveTimer.current !== null) void handleSaveClientDisguise()
    }
  }, [])

  async function handleSaveClientDisguise() {
    if (disguiseSaveTimer.current !== null) {
      clearTimeout(disguiseSaveTimer.current)
      disguiseSaveTimer.current = null
    }
    disguisePending.current = { settings: disguiseDraftRef.current, revision: disguiseRevision.current }
    if (disguiseSaving.current) return
    disguiseSaving.current = true
    if (disguiseMounted.current) {
      setDisguiseBusy(true)
      setDisguiseNotice(null)
    }
    try {
      while (disguisePending.current) {
        const request = disguisePending.current
        disguisePending.current = null
        try {
          const res = await sendMessage<{ success: boolean; data?: ClientDisguiseSettings; error?: string }>('SET_CLIENT_DISGUISE', request.settings)
          if (!disguiseMounted.current || request.revision !== disguiseRevision.current) continue
          if (!res.success) {
            setDisguiseNotice(res.error || '保存失败')
            continue
          }
          const saved = res.data || request.settings
          disguiseDraftRef.current = saved
          setDisguiseDraft(saved)
          setDisguiseNotice('已保存（路由开启时生效）')
        } catch (error) {
          if (disguiseMounted.current && request.revision === disguiseRevision.current) {
            setDisguiseNotice(error instanceof Error ? error.message : '保存失败')
          }
        }
      }
    } finally {
      disguiseSaving.current = false
      if (disguiseMounted.current) setDisguiseBusy(false)
    }
  }

  const activeDisguiseDraft: ClientIdentity = disguiseDraft[disguiseTab] || { preset: 'off' }

  function updateActiveDisguise(patch: Partial<ClientIdentity>, immediate = false) {
    const current = disguiseDraftRef.current
    const active = current[disguiseTab] || { preset: 'off' as ClientPreset }
    const next = { ...current, [disguiseTab]: { ...active, ...patch } }
    disguiseDraftRef.current = next
    disguiseRevision.current += 1
    setDisguiseDraft(next)
    setDisguiseNotice(null)
    if (disguiseSaveTimer.current !== null) clearTimeout(disguiseSaveTimer.current)
    if (immediate) void handleSaveClientDisguise()
    else disguiseSaveTimer.current = setTimeout(() => void handleSaveClientDisguise(), 250)
  }

  function resetActiveDisguise() {
    const next = { ...disguiseDraftRef.current }
    delete next[disguiseTab]
    disguiseDraftRef.current = next
    disguiseRevision.current += 1
    setDisguiseDraft(next)
    setDisguiseHeadersDraft(current => {
      const updated = { ...current }
      delete updated[disguiseTab]
      return updated
    })
    void handleSaveClientDisguise()
  }

  async function handleSaveRouterSettings() {
    if (routingBusy) return
    if (!Number.isInteger(routerPort) || routerPort < 1 || routerPort > 65535) {
      alert('Port must be between 1 and 65535')
      return
    }
    const proxyUrl = routerProxy.trim()
    if (proxyUrl) {
      try {
        const parsed = new URL(proxyUrl)
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
          throw new Error('Use an HTTP(S) proxy URL without a path or query string.')
        }
      } catch {
        alert('Enter a valid HTTP(S) proxy URL, for example http://127.0.0.1:7890')
        return
      }
    }

    setRouterBusy(true)
    if (routerEnabled) {
      const res = await sendMessage<{ success: boolean; error?: string }>('UPDATE_ROUTER_SETTINGS', {
        port: routerPort,
        proxyUrl,
      })
      if (!res.success) {
        alert(`Could not update Router settings: ${res.error || 'Unknown error'}`)
        setRouterBusy(false)
        return
      }
    }
    await chrome.storage.local.set({ router_port: routerPort, routerProxy: proxyUrl })
    setRouterBusy(false)
  }

  async function handleToggleClientRouting() {
    if (routingBusy) return
    setRouterBusy(true)
    try {
      const result = await sendMessage<{ success: boolean; error?: string }>('SET_CLIENT_ROUTING', { format: providerTab, enabled: !routerClients[providerTab] })
      if (!result.success) alert(result.error || 'Could not update client routing')
      const status = await sendMessage<{ success: boolean; data?: { clients?: Partial<Record<ProviderFormat, boolean>> } }>('GET_ROUTER_STATUS')
      if (status.success) setRouterClients(status.data?.clients || {})
      await loadProviders()
    } finally { setRouterBusy(false) }
  }

  async function handleToggleRouter() {
    if (routingBusy) return
    if (routerEnabled && Object.values(routerClients).some(Boolean) && !confirm(`Switch ${Object.keys(routerClients).filter(format => routerClients[format as ProviderFormat]).join(', ')} to direct connection and stop Router?`)) return
    setRouterBusy(true)
    if (routerEnabled) {
      const res = await sendMessage<{ success: boolean; error?: string; data?: { enabled: boolean; running: boolean } }>('DISABLE_ROUTER')
      if (res.success) {
        setRouterClients({})
        setRouterEnabled(false)
        setRouterRunning(false)
        await chrome.storage.local.set({ router_enabled: false })
      } else {
        const status = await sendMessage<{ success: boolean; data?: { enabled: boolean; running: boolean; port?: number; clients?: Partial<Record<ProviderFormat, boolean>> } }>('GET_ROUTER_STATUS')
        if (status.success && status.data) {
          setRouterClients(status.data.clients || {})
          setRouterEnabled(status.data.enabled)
          setRouterRunning(status.data.running)
          if (status.data.port) setRouterPort(status.data.port)
        }
        alert(`Could not disable router: ${res.error || 'Unknown error'}`)
      }
    } else {
      const port = Number(routerPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        alert('Port must be between 1 and 65535')
        setRouterBusy(false)
        return
      }
      const res = await sendMessage<{ success: boolean; error?: string; data?: { enabled: boolean; running: boolean; port?: number } }>('ENABLE_ROUTER', { port, proxyUrl: routerProxy.trim() })
      if (res.success && res.data) {
        setRouterEnabled(res.data.enabled)
        setRouterRunning(res.data.running)
        setRouterPort(res.data.port || port)
        await chrome.storage.local.set({ router_enabled: res.data.enabled, router_port: res.data.port || port })
      } else {
        alert(`Could not enable router: ${res.error || 'Unknown error'}`)
      }
    }
    setRouterBusy(false)
  }

  async function handleExport() {
    const res = await sendMessage<{ success: boolean; data: ExportData }>('EXPORT_PROVIDERS')
    if (res.success && res.data) {
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `codexswitch-export-${new Date().toISOString().slice(0,10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  async function importProviderConfig(data: unknown): Promise<void> {
    const res = await sendMessage<{ success: boolean; error?: string }>('IMPORT_PROVIDERS', data)
    if (!res.success) {
      throw new Error(res.error || 'Invalid config')
    }
    await loadProviders()
  }

  async function tryImportFromClipboard(): Promise<boolean> {
    if (!navigator.clipboard?.readText) return false
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (!text) return false

      const data = JSON.parse(text)
      const validation = validateExportData(data)
      if (!validation.valid) return false

      await importProviderConfig(data)
      return true
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof DOMException) {
        return false
      }
      throw error
    }
  }

  async function handleImportClick() {
    setClipboardImporting(true)
    try {
      const imported = await tryImportFromClipboard()
      if (!imported) {
        importInputRef.current?.click()
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Invalid config')
    } finally {
      setClipboardImporting(false)
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      await importProviderConfig(data)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Invalid config file')
    }
    if (importInputRef.current) importInputRef.current.value = ''
  }


  async function testProvider(provider: Provider, routerFormat?: ProviderFormat) {
    if (routerFormat) {
      const routerProvider: RouterModelTestRequest = { ...provider, targetFormat: routerFormat }
      const result = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>('TEST_MODEL_VIA_ROUTER', routerProvider)
      await sendMessage('UPDATE_TEST_STATUS', {
        id: provider.id,
        result: result.data || { success: false, message: 'Request failed', error: result.error || 'Router test failed' },
      })
    } else {
      await sendMessage('TEST_PROVIDER', provider)
    }
  }

  async function handleTest(id: string, routerFormat?: ProviderFormat) {
    if (testingIds.has(id)) return
    setTestingIds(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    const p = providers.find(p => p.id === id)
    try {
      if (p) {
        await testProvider(p, routerFormat)
        await loadProviders()
      }
    } finally {
      setTestingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function handleTestAll() {
    setTestingAll(true)
    try {
      await Promise.all(visibleProviders.map(provider => testProvider(provider,
        provider.formatConversionEnabled && (provider.format || 'openai') !== providerTab ? providerTab : undefined,
      )))
      await loadProviders()
    } finally {
      setTestingAll(false)
    }
  }

  async function handleSwitchModel(id: string, model: string, selectedApiType?: 'chat' | 'responses' | 'messages') {
    const provider = providers.find(p => p.id === id)
    if (!provider) return
    const gm = { ...provider.groupModels }
    const ag = provider.activeGroup || 'default'
    const currentModels = gm[ag] || provider.models || []
    const idx = currentModels.findIndex(m => m.name === model)
    if (idx > 0) gm[ag] = [currentModels[idx], ...currentModels.filter((_, i) => i !== idx)]
    try {
      const result = await sendMessage<{ success: boolean; error?: string }>('UPDATE_PROVIDER', { id, updates: { model, ...(idx > 0 ? { groupModels: gm } : {}), ...(selectedApiType ? { selectedApiType } : {}) } })
      if (!result.success) { alert(`Could not switch model: ${result.error || 'Unknown error'}`); return }
    } catch (error) {
      alert(`Could not switch model: ${error instanceof Error ? error.message : 'Unknown error'}`)
      return
    }
    setOpenDropdownId(null)
    await loadProviders()
  }

  function openAdd() {
    setEditingProvider(null)
    setEditingRouterFormat(null)
    setFormTestViaRouter(false)
    setFormFormatConversionEnabled(false)
    setFormName(''); setFormBaseUrl(''); setFormApiKey(''); setFormModels([])
    setFormNewModel(''); setFormNewModelApiType(defaultApiTypeForFormat(providerTab)); setFormModelFilter('any'); setFormModelSearch(''); setFormTestModel(''); setFormTestResult(null); setFormApiType(defaultApiTypeForFormat(providerTab)); setFormFormat(providerTab); setFormGroupApiKeys({ default: '' }); setFormGroupModels({ default: [] }); setFormActiveGroup('default')
    setFormatModelDrafts(createEmptyFormatModelDrafts())
    setShowPanel(true)
  }

  function openEdit(sourceProvider: Provider, routerFormat?: ProviderFormat) {
    const provider = routerFormat ? projectRouterProvider(sourceProvider, routerFormat) : sourceProvider
    setEditingProvider(sourceProvider)
    setEditingRouterFormat(routerFormat && routerFormat !== (sourceProvider.format || 'openai') ? routerFormat : null)
    setFormTestViaRouter(false)
    setFormFormatConversionEnabled(provider.formatConversionEnabled === true)
    const gk = provider.groupApiKeys || { default: provider.apiKey || '' }
    const format = provider.format || 'openai'
    const fallbackApiType = provider.apiType || defaultApiTypeForFormat(format)
    const ag = provider.activeGroup || 'default'
    const fallbackModels = provider.model ? [{ name: provider.model, apiType: fallbackApiType, format }] : []
    const topModels = normalizeModelsForFormat(provider.models || fallbackModels, format, fallbackApiType)
    const gm = normalizeGroupModelsForFormat(provider.groupModels || provider.formatGroupModels?.[format] || { default: topModels }, format, fallbackApiType)
    const currentModels = gm[ag] || topModels
    const currentModel = currentModels.some(m => m.name === provider.model) ? provider.model : (currentModels[0]?.name || '')
    const drafts = createEmptyFormatModelDrafts()
    if (provider.formatGroupModels?.openai) {
      const openaiGroups = normalizeGroupModelsForFormat(provider.formatGroupModels.openai, 'openai', 'both')
      drafts.openai = { groupModels: openaiGroups, testModel: openaiGroups[ag]?.[0]?.name || '' }
    }
    if (provider.formatGroupModels?.anthropic) {
      const anthropicGroups = normalizeGroupModelsForFormat(provider.formatGroupModels.anthropic, 'anthropic', 'chat')
      drafts.anthropic = { groupModels: anthropicGroups, testModel: anthropicGroups[ag]?.[0]?.name || '' }
    }
    if (provider.formatGroupModels?.deepseek) {
      const groups = normalizeGroupModelsForFormat(provider.formatGroupModels.deepseek, 'deepseek', 'all')
      drafts.deepseek = { groupModels: groups, testModel: groups[ag]?.[0]?.name || '' }
    }
    drafts[format] = { groupModels: gm, testModel: currentModel }
    setFormName(provider.name); setFormBaseUrl(provider.baseUrl); setFormApiKey(gk[ag] || provider.apiKey || '')
    setFormModels(currentModels); setFormNewModel(''); setFormModelFilter('any'); setFormModelSearch('')
    setFormNewModelApiType(defaultApiTypeForFormat(format)); setFormTestModel(currentModel); setFormTestResult(null); setFormApiType(provider.apiType || defaultApiTypeForFormat(format)); setFormFormat(format); setFormGroupApiKeys(gk); setFormGroupModels(gm); setFormatModelDrafts(drafts); setFormActiveGroup(ag)
    setShowPanel(true)
  }

  function closePanel() { setShowPanel(false); setEditingProvider(null); setEditingRouterFormat(null); setFormTestViaRouter(false); setFormFormatConversionEnabled(false); setFormTestResult(null); setSyncModelsError(null) }

  function handleFormFormatChange(fmt: ProviderFormat) {
    if (fmt === formFormat) return

    const currentGroupModels = { ...formGroupModels, [formActiveGroup]: formModels }
    const nextDrafts: Record<ProviderFormat, FormatModelDraft> = {
      ...formatModelDrafts,
      [formFormat]: { groupModels: currentGroupModels, testModel: formTestModel },
    }

    const targetDraft = nextDrafts[fmt]
    const targetGroupModels = {
      ...createEmptyGroupModels(formGroupApiKeys, formActiveGroup),
      ...normalizeGroupModelsForFormat(targetDraft.groupModels, fmt, defaultApiTypeForFormat(fmt)),
    }
    const targetModels = targetGroupModels[formActiveGroup] || []
    const targetTestModel = targetModels.some(m => m.name === targetDraft.testModel)
      ? targetDraft.testModel
      : (targetModels[0]?.name || '')

    setFormatModelDrafts(nextDrafts)
    setFormFormat(fmt)
    setFormGroupModels(targetGroupModels)
    setFormModels(targetModels)
    setFormTestModel(targetTestModel)
    setFormNewModel('')
    setFormModelFilter('any')
    setFormModelSearch('')
    setFormTestResult(null)
    setFormApiType(defaultApiTypeForFormat(fmt))
    setFormNewModelApiType(defaultApiTypeForFormat(fmt))
  }

  function addFormModel() {
    const m = formNewModel.trim()
    if (m && !formModels.some(x => x.name === m)) {
      const apiType = formFormat === 'anthropic' ? 'messages' : formNewModelApiType
      const newModels = normalizeModelsForFormat([...formModels, { name: m, apiType, format: formFormat }], formFormat, apiType)
      setFormModels(newModels)
      setFormNewModel('')
      setFormNewModelApiType(defaultApiTypeForFormat(formFormat))
      if (!formTestModel) setFormTestModel(m)
    }
  }

  async function handleProviderQuickImport() {
    setProviderImporting(true)
    setProviderImportError('')
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) {
        setProviderImportError('未找到当前标签页')
        setProviderImporting(false)
        return
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          // Search all .cooked elements (Discourse has one per post)
          const cookedList = document.querySelectorAll('.cooked')
          if (!cookedList.length) return { error: '未找到内容容器' }

          let providerName = ''
          let providerUrl = ''
          let apiKey = ''
          const isProviderUrlCandidate = (url: string) => {
            const lower = url.toLowerCase()
            return /^https?:\/\//i.test(url) && !lower.includes('linux.do') && !lower.includes('cdn')
          }

          for (const cooked of cookedList) {
            let text = cooked.textContent || ''

            // Decode all base64 encoded parts in the text
            const b64Pattern = /[A-Za-z0-9+/]{20,}={0,2}/g
            text = text.replace(b64Pattern, (match) => {
              try {
                const decoded = atob(match)
                if (/^[\x20-\x7E\n\r\t\\]+$/.test(decoded)) {
                  return decoded.replace(/\\(.)/g, (_, ch) => {
                    if (ch === '/') return '/'
                    if (ch === 'n') return '\n'
                    if (ch === 't') return '\t'
                    if (ch === 'r') return '\r'
                    return ch
                  }).replace(/\s+/g, '')
                }
              } catch {}
              return match
            })

            // Deobfuscate: remove backslash before http, remove spaces in protocol and URL
            // Handle "http s", "h ttp s", "\http", etc.
            text = text.replace(/\\?\s*h\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\/\s*/g, (m) => m.includes('s') ? 'https://' : 'http://')
            // Remove spaces within URL-like segments (e.g. "305 90.on line" -> "30590.online")
            // Repeat until no more spaces to merge within URLs
            let prev = ''
            while (prev !== text) {
              prev = text
              text = text.replace(/(https?:\/\/[^\s]*?)([a-zA-Z0-9])\s+([a-zA-Z0-9])/g, '$1$2$3')
            }

            // Match URL from <a> tags
            const links = cooked.querySelectorAll('a')
            for (const a of links) {
              let href = a.href || ''
              const linkText = a.textContent?.trim() || ''

              // Extract real URL from Discourse redirect links (linux.do/redirect?url=...)
              const redirectMatch = href.match(/[?&]url=([^&]+)/)
              if (redirectMatch) {
                try { href = decodeURIComponent(redirectMatch[1]) } catch {}
              }

              if (href && isProviderUrlCandidate(href)) {
                providerUrl = href
                providerName = linkText
                break
              }
            }

            // Fallback: match raw URL from decoded text
            if (!providerUrl) {
              const urlMatches = text.match(/https?:\/\/[^\s<>"']+/g) || []
              const urlMatch = urlMatches.find(isProviderUrlCandidate)
              if (urlMatch) {
                providerUrl = urlMatch
              }
            }

            if (providerUrl) {
              // Match API keys from decoded text
              const keyPatterns = [
                /\bsk-[A-Za-z0-9_-]{10,}\b/gi,
                /\b[A-Za-z]{2}-[A-Za-z0-9_-]{10,}\b/g,
              ]
              for (const pattern of keyPatterns) {
                const match = pattern.exec(text)
                if (match) {
                  apiKey = match[0]
                  break
                }
              }
              break
            }
          }

          if (!providerUrl) return { error: '未找到 API URL' }

          return { name: providerName, url: providerUrl, apiKey }
        },
      })

      const data = results?.[0]?.result as { error?: string; name?: string; url?: string; apiKey?: string } | undefined
      if (!data) {
        setProviderImportError('导入失败，未获取到结果')
        setProviderImporting(false)
        return
      }

      if (data.error) {
        setProviderImportError(data.error)
        setProviderImporting(false)
        return
      }

      if (data.name) setFormName(data.name)
      if (data.url) {
        let url = data.url
        if (!url.endsWith('/v1') && !url.endsWith('/v1/')) {
          url = url.replace(/\/+$/, '') + '/v1'
        }
        setFormBaseUrl(url)
      }
      if (data.apiKey) {
        setFormApiKey(data.apiKey)
        setFormGroupApiKeys(prev => ({ ...prev, [formActiveGroup]: data.apiKey! }))
      }
    } catch (err) {
      setProviderImportError('导入失败: ' + (err instanceof Error ? err.message : 'unknown'))
    } finally {
      setProviderImporting(false)
    }
  }

  async function handleSyncModels() {
    if (!formBaseUrl.trim()) {
      setSyncModelsError('Base URL is required')
      return
    }
    setSyncingModels(true)
    setSyncModelsError(null)
    const res = await sendMessage<{ success: boolean; data?: string[]; error?: string }>('FETCH_PROVIDER_MODELS', {
      baseUrl: formBaseUrl,
      apiKey: formApiKey || undefined,
      format: formFormat,
    })
    if (res.success && res.data) {
      const defaultApiType: ApiType = defaultApiTypeForFormat(formFormat)
      const existingNames = new Set(formModels.map(m => m.name.toLowerCase()))
      const newModels = filterModelNamesForFormat(res.data, formFormat)
        .filter(name => !existingNames.has(name.toLowerCase()))
        .map(name => ({ name, apiType: defaultApiType, format: formFormat }))
      setFormModels(prev => normalizeModelsForFormat([...prev, ...newModels], formFormat, defaultApiType))
      if (!formTestModel && newModels.length > 0) {
        setFormTestModel(newModels[0].name)
      }
    } else {
      setSyncModelsError(res.error || 'Failed to fetch models')
    }
    setSyncingModels(false)
  }

  function toggleModelApiType(modelName: string) {
    setFormModels(formModels.map(m => {
      if (m.name !== modelName) return m
      const types: ApiType[] = formFormat === 'deepseek' ? ['chat', 'responses', 'messages', 'both', 'all'] : ['chat', 'responses', 'both']
      const next = types[(types.indexOf(m.apiType) + 1) % types.length]
      return { ...m, apiType: next, format: formFormat }
    }))
  }

  async function toggleChatModelApiType(name: string) {
    const provider = providers.find(item => item.id === chatProviderId)
    if (!provider) return
    const format = provider.format || 'openai'
    const types: ApiType[] = format === 'deepseek' ? ['chat', 'responses', 'messages', 'both', 'all'] : ['chat', 'responses', 'both']
    const models = (provider.models || [{ name, apiType: defaultApiTypeForFormat(format) }]).map(model =>
      model.name === name ? { ...model, apiType: types[(types.indexOf(model.apiType) + 1) % types.length] } : model)
    const group = provider.activeGroup || 'default'
    const groups = { ...provider.groupModels, [group]: models }
    const result = await sendMessage<{ success: boolean; error?: string }>('UPDATE_PROVIDER', {
      id: provider.id, updates: { models, groupModels: groups, formatGroupModels: { ...provider.formatGroupModels, [format]: groups } },
    })
    if (!result.success) { setChatError(result.error || 'Could not update model protocol'); return }
    await loadProviders()
  }

  function removeFormModel(m: string) {
    if (formModels.length <= 1) return
    const newModels = formModels.filter(x => x.name !== m)
    setFormModels(newModels)
    if (formTestModel === m) {
      setFormTestModel(newModels[0]?.name || '')
    }
  }

  function clearFormModels() {
    if (formModels.length === 0) return
    setFormModels([])
    setFormTestModel('')
    setFormModelFilter('any')
    setEditingModelName(null)
    setEditingModelValue('')
    setFormModelSearch('')
  }

  async function handleFormTest() {
    if (!formTestModel || formTesting) return
    setFormTesting(true); setFormTestResult(null); setExpandedEndpoint(null)
    try {
      const testApiType = formModels.find(m => m.name === formTestModel)?.apiType || formApiType
      const tempProvider: RouterModelTestRequest = editingRouterFormat && editingProvider
        ? {
          ...editingProvider,
          model: formTestModel,
          models: routerTestModels,
          apiType: routerTestModels.find(model => model.name === formTestModel)?.apiType || editingProvider.apiType,
          apiKey: editingProvider.groupApiKeys?.[editingProvider.activeGroup || 'default'] ?? editingProvider.apiKey,
          targetFormat: editingRouterFormat,
        }
        : { id: 'temp', name: '', baseUrl: formBaseUrl, apiKey: formApiKey, model: formTestModel, models: formModels, apiType: testApiType, format: formFormat, formatConversionEnabled: formFormatConversionEnabled, groupApiKeys: formGroupApiKeys, groupModels: { ...formGroupModels, [formActiveGroup]: formModels }, activeGroup: formActiveGroup, isActive: false, createdAt: 0, updatedAt: 0 }
      const res = await sendMessage<{ success: boolean; data?: TestResult; error?: string }>(formTestUsesRouter ? 'TEST_MODEL_VIA_ROUTER' : 'TEST_PROVIDER', tempProvider)
      if (res.success && res.data) {
        setFormTestResult(res.data)
        if (res.data.correctedBaseUrl && !editingRouterFormat) setFormBaseUrl(res.data.correctedBaseUrl)
      } else {
        setFormTestResult({ success: false, message: 'Request failed', error: res.error || 'Request failed' })
      }
    } catch (error) {
      setFormTestResult({ success: false, message: 'Request failed', error: error instanceof Error ? error.message : 'Request failed' })
    }
    setFormTesting(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (routingBusy || editingRouterFormat) return
    setSaving(true)
    const currentGroupModels = { ...formGroupModels, [formActiveGroup]: formModels }
    const nextDrafts: Record<ProviderFormat, FormatModelDraft> = {
      ...formatModelDrafts,
      [formFormat]: { groupModels: currentGroupModels, testModel: formTestModel },
    }
    const formatGroupModels = {
      openai: normalizeGroupModelsForFormat(nextDrafts.openai.groupModels, 'openai', 'both'),
      anthropic: normalizeGroupModelsForFormat(nextDrafts.anthropic.groupModels, 'anthropic', 'messages'),
      deepseek: normalizeGroupModelsForFormat(nextDrafts.deepseek.groupModels, 'deepseek', 'all'),
    }
    const data = {
      name: formName, baseUrl: formBaseUrl, apiKey: formApiKey,
      model: formModels[0]?.name || '', models: formModels, apiType: formApiType, format: formFormat,
      formatConversionEnabled: formFormatConversionEnabled,
      groupApiKeys: { ...formGroupApiKeys, [formActiveGroup]: formApiKey }, groupModels: currentGroupModels, formatGroupModels, activeGroup: formActiveGroup,
      isActive: editingProvider?.isActive || false,
    }
    try {
      const res = editingProvider
        ? await sendMessage<{ success: boolean; error?: string }>('UPDATE_PROVIDER', { id: editingProvider.id, updates: data })
        : await sendMessage<{ success: boolean; error?: string }>('ADD_PROVIDER', data)
      if (!res.success) {
        alert(`Could not save provider: ${res.error || 'Unknown error'}`)
        return
      }
      closePanel()
      await loadProviders()
      setSelectedIds(new Set())
      setOpenDropdownId(null)
      setDragId(null)
      setDragOverId(null)
    } catch (error) {
      alert(`Could not save provider: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(entries: Provider[], targetFormat: ProviderFormat) {
    if (routingBusy || entries.length === 0) return
    setProviderDeleteBusy(true)
    const removedIds = new Set<string>()
    try {
      for (const provider of entries) {
        const viaRouter = (provider.format || 'openai') !== targetFormat
        const res = viaRouter
          ? await sendMessage<{ success: boolean; error?: string }>('UPDATE_PROVIDER', {
            id: provider.id,
            updates: { formatConversionEnabled: false },
          })
          : await sendMessage<{ success: boolean; error?: string }>('DELETE_PROVIDER', provider.id)
        if (!res.success) {
          throw new Error(`Could not ${viaRouter ? 'remove Router entry for' : 'delete provider'} ${provider.name}: ${res.error || 'Unknown error'}`)
        }
        removedIds.add(provider.id)
      }
      setSelectMode(false)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not remove provider entries')
    } finally {
      setSelectedIds(prev => new Set([...prev].filter(id => !removedIds.has(id))))
      setOpenDropdownId(null)
      setDragId(null)
      setDragOverId(null)
      try {
        await loadProviders()
      } catch (error) {
        alert(`Could not reload providers: ${error instanceof Error ? error.message : 'Unknown error'}`)
      } finally {
        setProviderDeleteBusy(false)
      }
    }
  }

  async function handleDeleteSelected() {
    await handleDelete(tabProviders.filter(provider => selectedIds.has(provider.id)), providerTab)
  }

  function toggleSelect(id: string) {
    if (providerDeleteBusy) return
    setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function toggleSelectAll() {
    if (providerDeleteBusy) return
    setSelectedIds(selectedIds.size === tabProviders.length ? new Set() : new Set(tabProviders.map(provider => provider.id)))
  }

  function exitSelectMode() { setSelectMode(false); setSelectedIds(new Set()) }

  function handleProviderTabChange(format: ProviderFormat) {
    if (format === providerTab) return
    setProviderTab(format)
    setSelectedIds(new Set())
    setOpenDropdownId(null)
    setDragId(null)
    setDragOverId(null)
    setDragOverTab(null)
  }

  function handleProviderTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, format: ProviderFormat) {
    let nextFormat: ProviderFormat
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const formats: ProviderFormat[] = ['openai', 'anthropic', 'deepseek']
      nextFormat = formats[(formats.indexOf(format) + (event.key === 'ArrowRight' ? 1 : 2)) % formats.length]
    } else if (event.key === 'Home') {
      nextFormat = 'openai'
    } else if (event.key === 'End') {
      nextFormat = 'deepseek'
    } else {
      return
    }
    event.preventDefault()
    handleProviderTabChange(nextFormat)
    document.getElementById(`provider-tab-${nextFormat}`)?.focus()
  }

  async function handleDrop(targetId: string) {
    const sourceId = dragId
    setDragId(null)
    setDragOverId(null)
    if (selectMode || !sourceId || sourceId === targetId) return

    const sourceProvider = providers.find(provider => provider.id === sourceId)
    const targetProvider = providers.find(provider => provider.id === targetId)
    if (!sourceProvider || !targetProvider) return
    const format = sourceProvider.format || 'openai'
    if (format !== (targetProvider.format || 'openai')) return

    const groupProviders = providers.filter(provider => (provider.format || 'openai') === format)
    const sourceIndex = groupProviders.findIndex(provider => provider.id === sourceId)
    const targetIndex = groupProviders.findIndex(provider => provider.id === targetId)
    groupProviders.splice(sourceIndex, 1)
    groupProviders.splice(targetIndex, 0, sourceProvider)
    let groupIndex = 0
    const reordered = providers.map(provider =>
      (provider.format || 'openai') === format ? groupProviders[groupIndex++] : provider
    )
    setProviders(reordered)
    await sendMessage('REORDER_PROVIDERS', reordered.map(provider => provider.id))
  }

  async function handleSiteDrop(targetId: string) {
    if (!siteDragId || siteDragId === targetId) { setSiteDragId(null); setSiteDragOverId(null); return }
    const ids = sites.map(s => s.id)
    const fromIdx = ids.indexOf(siteDragId)
    const toIdx = ids.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) { setSiteDragId(null); setSiteDragOverId(null); return }
    const newIds = [...ids]
    newIds.splice(fromIdx, 1)
    newIds.splice(toIdx, 0, siteDragId)
    const reordered = newIds.map(id => sites.find(s => s.id === id)!)
    setSites(reordered)
    await sendMessage('REORDER_SITES', newIds)
    setSiteDragId(null)
    setSiteDragOverId(null)
  }

  async function handleCopy(p: Provider) {
    const res = await sendMessage<{ success: boolean; data: Provider }>('ADD_PROVIDER', {
      name: p.name + ' (copy)',
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model: p.model,
      models: p.models,
      apiType: p.apiType,
      format: p.format,
      formatConversionEnabled: p.formatConversionEnabled === true,
      groupApiKeys: p.groupApiKeys || {},
      groupModels: p.groupModels || {},
      formatModels: p.formatModels,
      formatGroupModels: p.formatGroupModels,
      activeGroup: p.activeGroup || 'default',
      isActive: false,
    })
    if (res.success && res.data) {
      setProviders(prev => [...prev, res.data!])
    }
  }

  async function handleCopyToFormat(source: Provider, targetFormat: ProviderFormat) {
    const sourceFormat = source.format || 'openai'
    if (sourceFormat === targetFormat) return
    const targetApiType = defaultApiTypeForFormat(targetFormat)
    const convertModels = (models: ModelEntry[]): ModelEntry[] =>
      (models || []).map(model => ({ ...model, apiType: targetApiType, format: targetFormat }))
    const groupModels: Record<string, ModelEntry[]> = {}
    for (const [group, models] of Object.entries(source.groupModels || {})) {
      groupModels[group] = convertModels(models)
    }
    const res = await sendMessage<{ success: boolean; data: Provider }>('ADD_PROVIDER', {
      name: `${source.name} (${targetFormat})`,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      model: source.model,
      models: convertModels(source.models || []),
      apiType: targetApiType,
      format: targetFormat,
      formatConversionEnabled: source.formatConversionEnabled === true,
      groupApiKeys: source.groupApiKeys || {},
      groupModels,
      activeGroup: source.activeGroup || 'default',
      isActive: false,
    })
    if (res.success && res.data) {
      setProviders(prev => [...prev, res.data!])
    }
  }

  async function handleShareProvider(p: Provider) {
    const data = exportProviders([p])
    const ok = await copyToClipboard(JSON.stringify(data, null, 2))
    if (!ok) {
      alert('复制 provider 配置失败')
      return
    }
    setSharedProviderId(p.id)
    window.setTimeout(() => {
      setSharedProviderId(current => current === p.id ? null : current)
    }, 1500)
  }

  const chatProvider = providers.find(p => p.id === chatProviderId)
  const visibleProviders = providers
  const draggedProvider = providers.find(provider => provider.id === dragId)
  const providerGroups: { format: ProviderFormat; title: string; providers: Provider[] }[] = [
    {
      format: 'openai' as const,
      title: 'OpenAI',
      providers: visibleProviders.filter(provider => (provider.format !== 'deepseek' && provider.formatConversionEnabled === true) || (provider.format || 'openai') === 'openai'),
    },
    {
      format: 'anthropic' as const,
      title: 'Anthropic',
      providers: visibleProviders.filter(provider => (provider.format !== 'deepseek' && provider.formatConversionEnabled === true) || provider.format === 'anthropic'),
    },
  ]
  providerGroups.push({ format: 'deepseek' as const, title: 'DeepSeek', providers: visibleProviders.filter(provider => provider.format === 'deepseek') })
  const tabProviders = providerGroups.find(group => group.format === providerTab)?.providers || []

  async function handleChatSend() {
    if ((!chatInput.trim() && !chatAttachment) || !chatProvider || chatStreaming) return

    let content = chatInput.trim()
    if (chatAttachment) {
      content = `${content}\n\n[Attachment: ${chatAttachment.name}]\n\`\`\`\n${chatAttachment.content}\n\`\`\``
    }

    const userMsg: ChatMessage = { role: 'user', content }
    const newMessages = [...chatMessages, userMsg]
    setChatMessages(newMessages)
    setChatInput('')
    setChatAttachment(null)
    setChatStreaming(true)
    setChatError(null)

    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }
    setChatMessages([...newMessages, assistantMsg])

    try {
      const port = (chrome as any).runtime.connect({ name: 'chat-stream' })
      const providerFormat = chatProvider.format || 'openai'
      const selectedApiType = chatProvider.models?.find(m => m.name === chatModel)?.apiType || chatProvider.apiType || defaultApiTypeForFormat(providerFormat)
      port.postMessage({ baseUrl: chatProvider.baseUrl, apiKey: chatProvider.apiKey, model: chatModel, messages: newMessages, apiType: selectedApiType, format: providerFormat })

      const chunks: string[] = []
      await new Promise<void>((resolve, reject) => {
        port.onMessage.addListener((msg: { type: string; data?: string; error?: string }) => {
          if (msg.type === 'chunk' && msg.data) {
            chunks.push(msg.data)
            assistantMsg.content = chunks.join('')
            setChatMessages([...newMessages, { ...assistantMsg }])
          } else if (msg.type === 'done') {
            resolve()
          } else if (msg.type === 'error') {
            reject(new Error(msg.error || 'Stream error'))
          }
        })
        port.onDisconnect.addListener(() => { if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)) })
      })
      port.disconnect()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Chat error')
    }

    setChatStreaming(false)
  }

  function handleChatKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleChatSend()
    }
  }

  function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      const content = reader.result as string
      setChatAttachment({
        name: file.name,
        content,
        type: file.type || 'text/plain',
      })
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function removeAttachment() {
    setChatAttachment(null)
  }

  async function createNewSession() {
    const res = await sendMessage<{ success: boolean; data: ChatSession }>('SAVE_CHAT_SESSION', { id: null, providerId: chatProviderId || '', model: chatModel || '', messages: [] })
    if (res.success && res.data) {
      setChatSessions(prev => [res.data, ...prev])
      setActiveSessionId(res.data.id)
      setChatMessages([])
      setChatError(null)
      setShowSessionList(false)
    }
  }

  async function switchSession(id: string) {
    const session = chatSessions.find(s => s.id === id)
    if (session) {
      await sendMessage('SET_ACTIVE_SESSION', id)
      setActiveSessionId(id)
      setChatProviderId(session.providerId)
      setChatModel(session.model)
      setChatMessages(session.messages)
      setChatError(null)
      setShowSessionList(false)
    }
  }

  async function deleteSession(id: string) {
    await sendMessage('DELETE_CHAT_SESSION', id)
    const res = await sendMessage<{ success: boolean; data: { sessions: ChatSession[]; activeId: string | null } }>('GET_CHAT_SESSIONS')
    if (res.success && res.data) {
      setChatSessions(res.data.sessions)
      if (res.data.activeId !== activeSessionId) {
        const active = res.data.sessions.find(s => s.id === res.data.activeId)
        if (active) {
          setActiveSessionId(active.id)
          setChatProviderId(active.providerId)
          setChatModel(active.model)
          setChatMessages(active.messages)
        } else {
          setActiveSessionId(null)
          setChatMessages([])
        }
      }
    }
  }

  function clearChat() {
    setChatMessages([])
    setChatError(null)
  }

  return (
    <div className="relative h-screen bg-[#f8f9fb] text-slate-800 flex flex-col">
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowChat(true)}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm shadow-blue-500/20 hover:opacity-80 transition-opacity"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
          </button>
          <span className="text-[14px] font-bold tracking-tight text-slate-900">Codex Switch</span>
          <div className="flex items-center gap-0.5">
            <button onClick={openAdd} aria-label="Add provider" className="w-7 h-7 flex items-center justify-center rounded-md bg-blue-500 hover:bg-blue-600 text-white shadow-sm shadow-blue-500/20 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
        </div>
      </div>

      {!activeProvider && <div className="px-4 py-2 text-xs text-slate-400">{providerTab}: No provider selected</div>}
      {activeProvider && (
        <div className="shrink-0 mx-4 mb-2 px-3 py-2 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 shadow-sm ring-1 ring-blue-200/80">
          <div className="flex items-center gap-1.5 mb-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[8px] font-bold text-emerald-500 uppercase tracking-widest">Active</span>
          </div>
          <div className="text-[11px] font-semibold text-slate-800 truncate">{activeProvider.name}</div>
          <div className="text-[9px] text-slate-400 font-mono truncate">{activeProvider.model} · {selectedProtocol(activeProvider)} · {routerClients[providerTab] ? '使用路由' : '直连'}</div>
          <div className="mt-0.5">
            <StatusBadge status={activeProvider.testStatus} loading={testingIds.has(activeProvider.id) || testingAll} />
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50/60 overflow-visible">
          {!showPanel && !showChat && !showSettings && !showRouterSettings && (
          <div role="tablist" aria-label="Provider formats" aria-orientation="horizontal" className="sticky top-0 z-20 flex border-b border-slate-200 bg-slate-50 px-2">
            {providerGroups.map(group => (
              <button
                key={group.format}
                type="button"
                role="tab"
                id={`provider-tab-${group.format}`}
                aria-controls={`provider-panel-${group.format}`}
                aria-selected={providerTab === group.format}
                tabIndex={providerTab === group.format ? 0 : -1}
                onClick={() => handleProviderTabChange(group.format)}
                onKeyDown={event => handleProviderTabKeyDown(event, group.format)}
                onDragOver={event => {
                  if (selectMode || !dragId) return
                  const dragged = providers.find(provider => provider.id === dragId)
                  if (dragged && (dragged.format || 'openai') !== group.format) {
                    event.preventDefault()
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
                    if (dragOverTab !== group.format) setDragOverTab(group.format)
                  }
                }}
                onDragLeave={() => { if (dragOverTab === group.format) setDragOverTab(null) }}
                onDrop={event => {
                  event.preventDefault()
                  const dragged = providers.find(provider => provider.id === dragId)
                  const sourceId = dragId
                  setDragId(null)
                  setDragOverId(null)
                  setDragOverTab(null)
                  if (selectMode || !dragged || !sourceId) return
                  if ((dragged.format || 'openai') === group.format) return
                  void handleCopyToFormat(dragged, group.format)
                }}
                className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
                  dragOverTab === group.format
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                    : providerTab === group.format ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {group.title}
                <span aria-hidden="true" className="rounded bg-slate-100 px-1 text-[9px] text-slate-500">{group.providers.length}</span>
              </button>
            ))}
          </div>
          )}
          {visibleProviders.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-slate-50/50">
              <button
                onClick={handleTestAll}
                disabled={testingAll || testingIds.size > 0}
                className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-amber-600 bg-amber-50 hover:bg-amber-100 ring-1 ring-amber-200/60 transition-colors disabled:opacity-40"
              >
                {testingAll ? (
                  <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                ) : (
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                )}
                Test All
              </button>
              {selectMode ? (
                <>
                  <button onClick={toggleSelectAll} disabled={tabProviders.length === 0 || providerDeleteBusy} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100 ring-1 ring-slate-200/60 transition-colors disabled:opacity-40">
                    {tabProviders.length > 0 && selectedIds.size === tabProviders.length ? 'Deselect' : 'All'}
                  </button>
                  {selectedIds.size > 0 && (
                    <button onClick={handleDeleteSelected} disabled={routingBusy} title="Remove Router entries by turning off format conversion; delete native providers" className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-red-500 bg-red-50 hover:bg-red-100 ring-1 ring-red-200/60 transition-colors disabled:opacity-40">
                      Del ({selectedIds.size})
                    </button>
                  )}
                  <button onClick={exitSelectMode} disabled={providerDeleteBusy} aria-label="Exit selection mode" className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 transition-colors">
                    <svg className="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </>
              ) : (
                <button onClick={() => setSelectMode(true)} disabled={tabProviders.length === 0} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100 ring-1 ring-slate-200/60 transition-colors disabled:opacity-40">
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  Select
                </button>
              )}
              <div className="flex items-center gap-1 ml-auto">
                <span className="text-[8px] font-semibold text-slate-400 uppercase tracking-wider">Sync</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={syncEnabled}
                  onClick={handleToggleSync}
                  className={`relative w-8 h-4 rounded-full transition-colors duration-200 ${syncEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${syncEnabled ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between px-3 py-2 text-xs border-b border-slate-200/60 bg-slate-50/60">
            <label htmlFor="client-routing" className="flex flex-col leading-tight">
              <span className="font-semibold text-slate-700">使用路由</span>
              <span className="text-[9px] text-slate-400">{routerClients[providerTab] ? `${providerTab} 经 Router 转发` : `${providerTab} 直连选中 Provider`}</span>
            </label>
            <button
              id="client-routing"
              type="button"
              role="switch"
              aria-label="使用路由"
              aria-checked={!!routerClients[providerTab]}
              disabled={routingBusy || (!routerClients[providerTab] && !routerAvailable)}
              onClick={handleToggleClientRouting}
              className={`relative w-8 h-4 shrink-0 rounded-full transition-colors disabled:opacity-50 ${routerClients[providerTab] ? 'bg-emerald-500' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${routerClients[providerTab] ? 'translate-x-4' : ''}`} />
            </button>
          </div>


          {providerGroups.map(group => (
            <div
              key={group.format}
              role="tabpanel"
              id={`provider-panel-${group.format}`}
              aria-labelledby={`provider-tab-${group.format}`}
              hidden={providerTab !== group.format}
              tabIndex={0}
            >
              {providerTab === group.format && (
                group.providers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-2">
                    <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
                      <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>
                    </div>
                    <span className="text-[10px] text-slate-300">{visibleProviders.length === 0 ? 'Click + to add a provider' : `No ${group.title} providers yet`}</span>
                  </div>
                ) : (
                  <div className="p-2 space-y-1.5">
                    {group.providers.map((sourceProvider, providerIndex) => {
                      const providerFormat = sourceProvider.format || 'openai'
                      const viaRouter = providerFormat !== group.format
                      const provider = viaRouter ? projectRouterProvider(sourceProvider, group.format) : sourceProvider
                      const isSelected = sourceProvider === tabActiveProvider(group.format)
                      const modelChoices = provider.format === 'deepseek' ? (provider.models || []).flatMap(model => concreteApiTypes(model.apiType).map(apiType => ({ ...model, apiType }))) : provider.models || []
                      const routerTarget = group.format === 'anthropic' ? 'Messages' : group.format === 'deepseek' ? 'Chat Completions / Responses / Messages' : 'Chat Completions / Responses'
                      const routerEntryTitle = `${routerTarget} via Router; upstream: ${providerFormat}. Uses the original provider.${routerAvailable ? '' : ' Enable the global Router first.'}`
                      const isDragging = dragId === provider.id
                      const isBeforeTarget = dragOverId !== null && !isDragging && draggedProvider && (draggedProvider.format || 'openai') === providerFormat && (() => {
                        const ids = group.providers.filter(otherProvider => (otherProvider.format || 'openai') === providerFormat).map(otherProvider => otherProvider.id)
                        const dragIdx = ids.indexOf(dragId!)
                        const overIdx = ids.indexOf(dragOverId!)
                        const currentIdx = ids.indexOf(provider.id)
                        if (dragIdx < overIdx) return currentIdx > dragIdx && currentIdx <= overIdx
                        if (dragIdx > overIdx) return currentIdx >= overIdx && currentIdx < dragIdx
                        return false
                      })()
                      return (
                      <article
                        key={`${provider.id}:${providerIndex}`}
                        aria-label={provider.name}
                        draggable={!selectMode}
                        onDragStart={() => { if (!selectMode) setDragId(provider.id) }}
                        onDragOver={event => {
                          if (!selectMode && draggedProvider && (draggedProvider.format || 'openai') === providerFormat) {
                            event.preventDefault()
                            setDragOverId(provider.id)
                          }
                        }}
                        onDragLeave={() => { if (dragOverId === provider.id) setDragOverId(null) }}
                        onDrop={event => { event.preventDefault(); void handleDrop(provider.id) }}
                        onDragEnd={() => { setDragId(null); setDragOverId(null); setDragOverTab(null) }}
                        className={`group rounded-lg ring-2 transition-all duration-200 ${
                          selectMode ? 'cursor-default' : 'cursor-pointer'
                        } ${isSelected
                          ? 'ring-emerald-400 bg-emerald-50/50 shadow-sm' : 'ring-slate-200 bg-white hover:ring-slate-300'} ${
                          selectMode && selectedIds.has(provider.id) ? 'ring-emerald-500 bg-emerald-50/70' : ''
                        } ${isDragging ? 'opacity-30 scale-[0.98]' : ''} ${dragOverId === provider.id && dragId !== provider.id ? 'ring-blue-400' : ''} ${isBeforeTarget && dragId !== null ? 'translate-y-1' : ''}`}
                        onClick={() => selectMode ? toggleSelect(provider.id) : handleSetActive(provider.id, group.format, viaRouter)}
                      >
                        <div className="flex items-start gap-2 px-2.5 py-1.5">
                          {selectMode ? (
                            <button
                              type="button"
                              role="checkbox"
                              aria-label={`Select ${provider.name}`}
                              aria-checked={selectedIds.has(provider.id)}
                              onClick={event => { event.stopPropagation(); toggleSelect(provider.id) }}
                              className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${
                              selectedIds.has(provider.id) ? 'bg-blue-500 border-blue-500' : 'border-slate-300 bg-white'
                            }`}>
                              {selectedIds.has(provider.id) && (
                                <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                              )}
                            </button>
                          ) : (
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 transition-all ${isSelected ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.4)]' : 'bg-slate-300'}`} />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={selectMode ? `Select ${provider.name}` : `Activate ${provider.name}`}
                                aria-pressed={!selectMode && isSelected}
                                disabled={selectMode ? providerDeleteBusy : routingBusy || (viaRouter && !routerAvailable)}
                                title={viaRouter ? routerEntryTitle : undefined}
                                onClick={event => { event.stopPropagation(); selectMode ? toggleSelect(provider.id) : handleSetActive(provider.id, group.format, viaRouter) }}
                                className="text-[11px] font-semibold text-slate-700 truncate"
                              >{provider.name}</button>
                              <span className={`shrink-0 px-1 py-px text-[6px] font-bold uppercase tracking-wider rounded ring-1 ${
                                group.format === 'anthropic' ? 'bg-orange-50 text-orange-500 ring-orange-200' : 'bg-blue-50 text-blue-500 ring-blue-200'
                              }`}>{group.format}</span>
                              {viaRouter && (
                                <span title={routerEntryTitle} className="shrink-0 px-1 py-px text-[6px] font-bold rounded ring-1 bg-purple-50 text-purple-500 ring-purple-200">Router</span>
                              )}
                              {provider.balance && (
                                <span className="shrink-0 text-[9px] font-semibold text-emerald-600 bg-emerald-50 px-1 py-px rounded">{provider.balance}</span>
                              )}
                            </div>
                            <div className="text-[9px] text-slate-400 font-mono truncate">{provider.baseUrl}</div>
                            <div className="relative inline-block" ref={openDropdownId === provider.id ? dropdownRef : undefined}>
                              <button
                                type="button"
                                aria-label={`Choose model for ${provider.name}`}
                                aria-expanded={openDropdownId === provider.id && modelChoices.length > 1}
                                onClick={event => { event.stopPropagation(); setOpenDropdownId(openDropdownId === provider.id ? null : provider.id) }}
                                className="flex items-center gap-0.5 text-[9px] text-slate-500 font-mono hover:text-blue-500 transition-colors"
                              >
                                <span className="truncate max-w-[100px]">{provider.model}</span>
                                {modelChoices.length > 1 && (
                                  <svg className="w-2 h-2 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                                )}
                              </button>
                              {openDropdownId === provider.id && modelChoices.length > 1 && (
                                <div className="absolute left-0 top-full mt-0.5 z-30 bg-white rounded-lg shadow-lg ring-1 ring-slate-200 py-0.5 min-w-max max-h-[72px] overflow-y-auto">
                                  {[...modelChoices].sort((firstModel, secondModel) => {
                                    if (firstModel.name === provider.model) return -1
                                    if (secondModel.name === provider.model) return 1
                                    return 0
                                  }).map(model => (
                                    <button
                                      key={`${model.name}:${model.apiType}`}
                                      onClick={event => { event.stopPropagation(); handleSwitchModel(provider.id, model.name, provider.format === 'deepseek' ? model.apiType as 'chat' | 'responses' | 'messages' : undefined) }}
                                      className={`w-full text-left px-2.5 py-1 text-[10px] font-mono hover:bg-blue-50 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                                        model.name === provider.model ? 'text-blue-600 font-semibold bg-blue-50/50' : 'text-slate-600'
                                      }`}
                                    >
                                      <span className={`shrink-0 px-1 py-px text-[6px] font-bold uppercase tracking-wider rounded ${
                                        provider.format === 'anthropic' ? 'bg-orange-50 text-orange-500'
                                          : model.apiType === 'both' ? 'bg-purple-50 text-purple-500'
                                          : model.apiType === 'responses' ? 'bg-blue-50 text-blue-500'
                                          : 'bg-amber-50 text-amber-500'
                                      }`}>{provider.format === 'anthropic' ? 'messages' : model.apiType}</span>
                                      <span className="truncate">{model.name}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center justify-between gap-2">
                              <StatusBadge status={provider.testStatus} loading={testingIds.has(provider.id) || testingAll} />
                              {!viaRouter && (
                                <div className="flex shrink-0 items-center gap-1" onClick={event => event.stopPropagation()}>
                                  <span className="text-[8px] text-slate-500">格式转换</span>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-label={`Format conversion for ${provider.name}`}
                                    aria-checked={provider.formatConversionEnabled === true}
                                    disabled={selectMode || routingBusy}
                                    title="开启后由 Router 提供 Chat Completions / Responses / Messages；需开启全局 Router"
                                    onClick={() => void handleToggleFormatConversion(provider)}
                                    className={`relative w-6 h-3 shrink-0 rounded-full transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 ${provider.formatConversionEnabled === true ? 'bg-purple-500' : 'bg-slate-300'}`}
                                  >
                                    <span className={`absolute top-0.5 left-0.5 w-2 h-2 rounded-full bg-white shadow-sm transition-transform ${provider.formatConversionEnabled === true ? 'translate-x-3' : ''}`} />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          {!selectMode && (
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 shrink-0">
                              <button
                                type="button"
                                aria-label={`Test ${provider.name}${viaRouter ? ' via Router' : ''}`}
                                onClick={event => { event.stopPropagation(); handleTest(provider.id, viaRouter ? group.format : undefined) }}
                                disabled={testingAll || testingIds.has(provider.id) || !provider.model}
                                title={!provider.model ? '请先选择模型再测试' : viaRouter ? '通过 Router 测试转换后的格式' : '测试'}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50 transition-colors disabled:opacity-20"
                              >
                                {testingIds.has(provider.id) ? (
                                  <svg className="w-2.5 h-2.5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                ) : (
                                  <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label={`Duplicate ${provider.name}`}
                                onClick={event => { event.stopPropagation(); handleCopy(sourceProvider) }}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                                title="Duplicate provider"
                              >
                                <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" /></svg>
                              </button>
                              <button
                                type="button"
                                aria-label={`Share ${provider.name}`}
                                onClick={event => { event.stopPropagation(); handleShareProvider(sourceProvider) }}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-emerald-50 transition-colors"
                                title={sharedProviderId === provider.id ? 'Provider config copied' : 'Share provider config'}
                              >
                                {sharedProviderId === provider.id ? (
                                  <svg className="w-2.5 h-2.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                                ) : (
                                  <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" /></svg>
                                )}
                              </button>
                              <button
                                type="button"
                                aria-label={`Edit ${provider.name}`}
                                title={viaRouter ? 'View Router format and models' : undefined}
                                onClick={event => { event.stopPropagation(); openEdit(sourceProvider, viaRouter ? group.format : undefined) }}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                              >
                                <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
                              </button>
                              <button
                                type="button"
                                aria-label={viaRouter ? `Remove Router entry for ${provider.name}` : `Delete ${provider.name}`}
                                title={viaRouter ? 'Remove Router entry by turning off format conversion; keep the original provider' : 'Delete provider and its Router entries'}
                                disabled={routingBusy}
                                onClick={event => { event.stopPropagation(); handleDelete([sourceProvider], group.format) }}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors disabled:opacity-40"
                              >
                                <svg className="w-2.5 h-2.5 text-slate-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    )})}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      </div>

      <section
        aria-label="路由设置面板"
        aria-hidden={!showRouterSettings}
        className={`absolute inset-0 z-50 flex flex-col bg-[#f8f9fb] shadow-xl transform transition-transform duration-200 ease-out ${showRouterSettings ? 'translate-x-0' : 'translate-x-full invisible'}`}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 pt-4 pb-3 border-b border-slate-200/60">
          <button type="button" aria-label="关闭路由设置" onClick={() => setShowRouterSettings(false)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h2 className="text-[14px] font-bold text-slate-900">路由设置</h2>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          <div className="mb-3">
            <div className="flex items-center gap-2 px-1 pb-2">
              <svg className="w-3.5 h-3.5 shrink-0 text-indigo-500" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75a3 3 0 100-6 3 3 0 000 6zM3 20.118a8.5 8.5 0 0113.5 0M16 5.25a2.25 2.25 0 010 4.5M18 20.118a6 6 0 00-2.5-4.33" /></svg>
              <span className="text-[10px] font-bold text-slate-800">客户端伪装</span>
              <span className="text-[8px] text-slate-400">让请求以指定的客户端身份发出</span>
            </div>
            <section aria-label="浏览器伪装成客户端" className="mb-3 rounded-xl overflow-hidden ring-1 ring-slate-200 bg-white">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
              <svg className="w-3.5 h-3.5 shrink-0 text-blue-500" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" /></svg>
              <span className="text-[9px] font-semibold text-slate-700">浏览器伪装成客户端</span>
              <span className="ml-auto text-[8px] text-slate-400">{identityBusy ? '应用中…' : identityNotice || '已启用'}</span>
            </div>
            <p className="px-3 pt-2 text-[8px] leading-relaxed text-slate-400">
              浏览器直连或经路由转发时，把请求伪装成所选客户端；按目标 provider 的格式选择身份。
            </p>
            <div role="tablist" aria-label="浏览器伪装作用范围" className="flex border-b border-slate-100 bg-slate-50/60">
              {(['default', 'openai', 'anthropic', 'deepseek'] as const).map(scope => (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={identityTab === scope}
                  onClick={() => setIdentityTab(scope)}
                  className={`flex-1 border-b-2 px-1 py-1.5 text-[8px] font-semibold transition-colors ${
                    identityTab === scope ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {scope === 'default' ? '默认' : PROVIDER_FORMAT_META[scope].label}
                  {scope !== 'default' && identityDraft.formatIdentities[scope] && (
                    <span aria-hidden="true" className="ml-0.5 rounded bg-blue-100 px-0.5 text-[7px] text-blue-600">自定</span>
                  )}
                </button>
              ))}
            </div>
            {(() => {
              const draft = activeIdentityDraft
              const showCustomization = draft.preset !== 'auto' && draft.preset !== 'off'
              return (
                <div className="flex flex-col gap-2 px-3 py-2">
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-[8px] font-semibold text-slate-500">预设</span>
                    <select
                      aria-label={`浏览器伪装预设（${identityTab === 'default' ? '默认' : PROVIDER_FORMAT_META[identityTab].label}）`}
                      value={draft.preset}
                      onChange={event => updateActiveIdentity({ preset: event.target.value as ClientPreset }, true)}
                      className="min-w-0 flex-1 px-2 py-1 text-[9px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400 disabled:bg-slate-100"
                    >
                      <option value="auto">Auto (match provider format)</option>
                      <option value="off">Off (default SDK headers)</option>
                      {Object.entries(CLIENT_PRESETS).map(([key, preset]) => (
                        <option key={key} value={key}>{preset.label}</option>
                      ))}
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {showCustomization && (
                    <>
                      {draft.preset !== 'custom' && (
                        <label className="flex items-center gap-2">
                          <span className="shrink-0 w-14 text-[8px] font-semibold text-slate-500">Version</span>
                          <input
                            type="text"
                            aria-label="客户端版本号"
                            value={draft.version || ''}
                            placeholder={CLIENT_PRESETS[draft.preset as keyof typeof CLIENT_PRESETS]?.defaultVersion}
                            onChange={event => updateActiveIdentity({ version: event.target.value })}
                            onBlur={() => void handleSaveClientIdentity()}
                            className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400 disabled:bg-slate-100"
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-2">
                        <span className="shrink-0 w-14 text-[8px] font-semibold text-slate-500">User-Agent</span>
                        <input
                          type="text"
                          aria-label="自定义 User-Agent"
                          value={draft.userAgent || ''}
                          placeholder={draft.preset === 'custom' ? 'codex_cli_rs/0.55.0' : 'override preset User-Agent (optional)'}
                          onChange={event => updateActiveIdentity({ userAgent: event.target.value })}
                          onBlur={() => void handleSaveClientIdentity()}
                          className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400 disabled:bg-slate-100"
                        />
                      </label>
                      <label className="flex items-start gap-2">
                        <span className="shrink-0 w-14 pt-1 text-[8px] font-semibold text-slate-500">配套头</span>
                        <textarea
                          aria-label="自定义请求头（每行一个 Header: Value）"
                          rows={3}
                          value={identityHeadersDraft[identityTab] ?? Object.entries(draft.extraHeaders || {}).map(([header, value]) => `${header}: ${value}`).join('\n')}
                          placeholder={'x-team: lab\nx-flag: on'}
                          onChange={event => {
                            // Preserve unfinished lines and whitespace while editing; parse only the applied snapshot.
                            const text = event.target.value
                            setIdentityHeadersDraft(current => ({ ...current, [identityTab]: text }))
                            const extraHeaders: Record<string, string> = {}
                            for (const line of text.split('\n')) {
                              const separator = line.indexOf(':')
                              if (separator <= 0) continue
                              const header = line.slice(0, separator).trim()
                              const value = line.slice(separator + 1).trim()
                              if (header && value) extraHeaders[header] = value
                            }
                            updateActiveIdentity({ extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined })
                          }}
                          onBlur={() => void handleSaveClientIdentity()}
                          className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400 disabled:bg-slate-100"
                        />
                      </label>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[8px] text-slate-400">
                      {identityTab === 'default' ? '作用于所有未单独配置的格式' : identityDraft.formatIdentities[identityTab] ? '覆盖此格式的默认身份' : '跟随默认配置'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {identityTab !== 'default' && identityDraft.formatIdentities[identityTab] && (
                        <button
                          type="button"
                          onClick={resetActiveIdentity}
                          className="px-2 py-1 text-[8px] font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded transition-colors disabled:opacity-50"
                        >
                          跟随默认
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleSaveClientIdentity()}
                        className="px-2 py-1 text-[8px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded transition-colors disabled:opacity-50"
                      >
                        Apply identity
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}
          </section>

          <section aria-label="客户端伪装成其他客户端" className="mb-3 rounded-xl overflow-hidden ring-1 ring-slate-200 bg-white">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
              <svg className="w-3.5 h-3.5 shrink-0 text-indigo-500" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75a3 3 0 100-6 3 3 0 000 6zM3 20.118a8.5 8.5 0 0113.5 0M16 5.25a2.25 2.25 0 010 4.5M18 20.118a6 6 0 00-2.5-4.33" /></svg>
              <span className="text-[9px] font-semibold text-slate-700">客户端伪装成其他客户端</span>
              <span className="ml-auto text-[8px] text-slate-400">{disguiseBusy ? '应用中…' : disguiseNotice || '仅路由开启时生效'}</span>
            </div>
            <p className="px-3 pt-2 text-[8px] leading-relaxed text-slate-400">
              按入口客户端分别指定转发到上游时要伪装成的客户端；在格式转换之后应用，覆盖上方「浏览器伪装成客户端」的设置。仅在路由开启时生效。
            </p>
            <div role="tablist" aria-label="入口客户端" className="flex mt-2 border-b border-slate-100 bg-slate-50/60">
              {(['openai', 'anthropic', 'deepseek'] as ProviderFormat[]).map(scope => (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={disguiseTab === scope}
                  onClick={() => setDisguiseTab(scope)}
                  className={`flex-1 border-b-2 px-1 py-1.5 text-[8px] font-semibold transition-colors ${
                    disguiseTab === scope ? 'border-blue-500 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {ENTRY_CLIENT_META[scope].label}
                  {disguiseDraft[scope] && disguiseDraft[scope]!.preset !== 'off' && (
                    <span aria-hidden="true" className="ml-0.5 rounded bg-blue-100 px-0.5 text-[7px] text-blue-600">已设</span>
                  )}
                </button>
              ))}
            </div>
            {(() => {
              const draft = activeDisguiseDraft
              const showCustomization = draft.preset !== 'off'
              return (
                <div className="flex flex-col gap-2 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[8px] text-slate-400">入口 {ENTRY_CLIENT_META[disguiseTab].hint}</span>
                  </div>
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-[8px] font-semibold text-slate-500">伪装成</span>
                    <select
                      aria-label={`${ENTRY_CLIENT_META[disguiseTab].label} 伪装目标`}
                      value={draft.preset}
                      onChange={event => updateActiveDisguise({ preset: event.target.value as ClientPreset }, true)}
                      className="min-w-0 flex-1 px-2 py-1 text-[9px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400"
                    >
                      <option value="off">Off（不伪装，跟随浏览器伪装设置）</option>
                      {Object.entries(CLIENT_PRESETS).map(([key, preset]) => (
                        <option key={key} value={key}>{preset.label}</option>
                      ))}
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {showCustomization && (
                    <>
                      {draft.preset !== 'custom' && (
                        <label className="flex items-center gap-2">
                          <span className="shrink-0 w-14 text-[8px] font-semibold text-slate-500">Version</span>
                          <input
                            type="text"
                            aria-label="伪装客户端版本号"
                            value={draft.version || ''}
                            placeholder={CLIENT_PRESETS[draft.preset as keyof typeof CLIENT_PRESETS]?.defaultVersion}
                            onChange={event => updateActiveDisguise({ version: event.target.value })}
                            onBlur={() => void handleSaveClientDisguise()}
                            className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400"
                          />
                        </label>
                      )}
                      <label className="flex items-center gap-2">
                        <span className="shrink-0 w-14 text-[8px] font-semibold text-slate-500">User-Agent</span>
                        <input
                          type="text"
                          aria-label="伪装 User-Agent"
                          value={draft.userAgent || ''}
                          placeholder={draft.preset === 'custom' ? 'codex_cli_rs/0.55.0' : '覆盖预设 User-Agent（可选）'}
                          onChange={event => updateActiveDisguise({ userAgent: event.target.value })}
                          onBlur={() => void handleSaveClientDisguise()}
                          className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400"
                        />
                      </label>
                      <label className="flex items-start gap-2">
                        <span className="shrink-0 w-14 pt-1 text-[8px] font-semibold text-slate-500">配套头</span>
                        <textarea
                          rows={3}
                          aria-label="伪装配套请求头（每行一个 Header: Value）"
                          value={disguiseHeadersDraft[disguiseTab] ?? Object.entries(draft.extraHeaders || {}).map(([header, value]) => `${header}: ${value}`).join('\n')}
                          placeholder={'x-client-name: codex_cli_rs\nx-app: cli'}
                          onChange={event => {
                            const text = event.target.value
                            setDisguiseHeadersDraft(current => ({ ...current, [disguiseTab]: text }))
                            const extraHeaders: Record<string, string> = {}
                            for (const line of text.split('\n')) {
                              const separator = line.indexOf(':')
                              if (separator <= 0) continue
                              const header = line.slice(0, separator).trim()
                              const value = line.slice(separator + 1).trim()
                              if (header && value) extraHeaders[header] = value
                            }
                            updateActiveDisguise({ extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined })
                          }}
                          onBlur={() => void handleSaveClientDisguise()}
                          className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400"
                        />
                      </label>
                    </>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[8px] text-slate-400">
                      {draft.preset === 'off' ? '不额外伪装' : '转发到上游时以此客户端身份发送'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {disguiseDraft[disguiseTab] && (
                        <button
                          type="button"
                          onClick={resetActiveDisguise}
                          className="px-2 py-1 text-[8px] font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded transition-colors"
                        >
                          清除
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleSaveClientDisguise()}
                        className="px-2 py-1 text-[8px] font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded transition-colors"
                      >
                        应用
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}
          </section>
          </div>

          <div className="rounded-xl overflow-hidden ring-1 ring-slate-200 bg-white">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-white/70">
            <svg className="w-3.5 h-3.5 shrink-0 text-emerald-600" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.5 12h7m-10.5 0a3 3 0 110-6h2m12 6a3 3 0 100-6h-2m-9 12h8a3 3 0 000-6h-8a3 3 0 000 6z" /></svg>
            <span className="text-[9px] font-semibold text-slate-700">Router</span>
            <span className="flex items-center gap-1 text-[8px] text-slate-500">
              <span className={`w-1.5 h-1.5 rounded-full ${routerEnabled && routerRunning ? 'bg-emerald-500' : routerEnabled ? 'bg-amber-500' : 'bg-slate-300'}`} />
              {routerEnabled ? (routerRunning ? `127.0.0.1:${routerPort}` : 'Service unavailable') : 'Stopped'}
            </span>
            <label className="ml-auto flex items-center gap-1">
              <span className="text-[8px] text-slate-500">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                aria-label="Router listening port"
                value={routerPort}
                disabled={routingBusy}
                onChange={event => {
                  const value = Number(event.target.value)
                  setRouterPort(value)
                }}
                className="w-16 px-1.5 py-1 text-[9px] text-right font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-400 disabled:bg-slate-50 disabled:text-slate-400"
              />
            </label>
            <button
              type="button"
              role="switch"
              aria-label="Local API Router"
              aria-checked={routerEnabled}
              disabled={routingBusy}
              onClick={handleToggleRouter}
              className={`relative w-8 h-4 shrink-0 rounded-full transition-colors disabled:opacity-50 ${routerEnabled ? 'bg-emerald-500' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full shadow-sm transition-transform ${routerEnabled ? 'translate-x-4' : ''}`} />
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-[8px] font-semibold text-slate-500">Upstream proxy</span>
              <input
                type="text"
                aria-label="Router upstream proxy URL"
                value={routerProxy}
                disabled={routingBusy}
                onChange={event => setRouterProxy(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void handleSaveRouterSettings() }}
                placeholder="Direct connection (or http://127.0.0.1:7890)"
                className="min-w-0 flex-1 px-2 py-1 text-[9px] font-mono bg-white border border-slate-200 rounded focus:outline-none focus:border-emerald-400 disabled:bg-slate-100"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleSaveRouterSettings()}
              disabled={routingBusy}
              className="shrink-0 px-2 py-1 text-[8px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition-colors disabled:opacity-50"
            >
              Apply
            </button>
          </div>

          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-400">路由服务启动后，在各 Provider 选项卡中独立开启“使用路由”。上游代理仅用于经过 Router 的请求。</p>
        </div>
      </section>

      <div className="shrink-0 px-4 py-2 border-t border-slate-200/60 bg-white/80 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowSettings(true)}
              className="w-7 h-7 flex items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm shadow-blue-500/20 hover:opacity-80 transition-opacity">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" /></svg>
            </button>
            <span className="text-[9px] text-slate-400">{providers.length} provider{providers.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input ref={importInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden" />
            <button onClick={handleImportClick} disabled={clipboardImporting}
              title="Import copied provider config from clipboard, or choose a JSON file"
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200/60 transition-colors disabled:opacity-40">
              {clipboardImporting ? (
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              )}
              {clipboardImporting ? 'Importing' : 'Import'}
            </button>
            <button onClick={handleExport} disabled={providers.length === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200/60 transition-colors disabled:opacity-30">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Export
            </button>
            <button
              type="button"
              aria-label="路由设置"
              title="路由设置"
              onClick={() => setShowRouterSettings(!showRouterSettings)}
              className="w-7 h-7 flex items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-sm shadow-blue-500/20 hover:opacity-80 transition-opacity"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.065 2.573c.94 1.543-.827 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.065c-1.543.94-3.31-.827-2.37-2.37a1.724 1.724 0 00-1.065-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.065-2.572c-.94-1.544.827-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            </button>
          </div>
        </div>
      </div>

      <div
        className={`absolute inset-0 bg-[#f8f9fb] z-20 transform transition-transform duration-200 ease-out shadow-xl ${
          showChat ? '-translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-full flex flex-col">
          <div className="shrink-0 px-4 pt-4 pb-2 border-b border-slate-200/60">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowSessionList(!showSessionList)}
                  className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                </button>
                <span className="text-[14px] font-bold text-slate-900 tracking-tight">AI Chat</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={createNewSession}
                  className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
                  title="New chat"
                >
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                </button>
                <button onClick={() => setShowChat(false)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors">
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <div ref={chatProviderDropdownRef} className="relative flex-1">
                <button
                  onClick={() => { setChatProviderDropdownOpen(!chatProviderDropdownOpen); setChatModelDropdownOpen(false) }}
                  className="w-full px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 text-slate-700 text-left flex items-center justify-between"
                >
                  <span className="truncate">{chatProvider?.name || 'Select provider'}</span>
                  <svg className="w-3 h-3 text-slate-400 shrink-0 ml-1" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {chatProviderDropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
                    {visibleProviders.map(p => (
                      <button
                        key={p.id}
                        onClick={() => { setChatProviderId(p.id); setChatModel(p.model); setChatProviderDropdownOpen(false) }}
                        className={`w-full px-2 py-1.5 text-[11px] text-left hover:bg-slate-50 ${p.id === chatProviderId ? 'bg-blue-50 text-blue-600' : 'text-slate-700'}`}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div ref={chatModelDropdownRef} className="relative flex-1">
                <button
                  onClick={() => { setChatModelDropdownOpen(!chatModelDropdownOpen); setChatProviderDropdownOpen(false) }}
                  className="w-full px-2 py-1.5 text-[11px] font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 text-slate-700 text-left flex items-center justify-between"
                >
                  <span className="truncate">{chatModel || 'Select model'}</span>
                  <svg className="w-3 h-3 text-slate-400 shrink-0 ml-1" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {chatModelDropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-40 overflow-y-auto">
                    {[...(chatProvider?.models || [{ name: chatModel, apiType: 'both' as ApiType }])].sort((a, b) => {
                      if (a.name === chatModel) return -1
                      if (b.name === chatModel) return 1
                      return 0
                    }).map(m => (
                      <button
                        key={m.name}
                        onClick={() => { setChatModel(m.name); setChatModelDropdownOpen(false) }}
                        className={`w-full px-2 py-1.5 text-[11px] font-mono text-left hover:bg-slate-50 flex items-center gap-1.5 ${m.name === chatModel ? 'bg-blue-50 text-blue-600' : 'text-slate-700'}`}
                      >
                        <button
                          type="button"
                          onClick={() => { if (chatProvider?.format !== 'anthropic') void toggleChatModelApiType(m.name) }}
                          className={`shrink-0 px-1 py-px text-[6px] font-bold uppercase tracking-wider rounded ${
                            chatProvider?.format === 'anthropic' ? 'bg-orange-50 text-orange-500 cursor-default'
                              : m.apiType === 'both' ? 'bg-purple-50 text-purple-500 cursor-pointer hover:opacity-80 transition-opacity'
                              : m.apiType === 'responses' ? 'bg-blue-50 text-blue-500 cursor-pointer hover:opacity-80 transition-opacity'
                              : 'bg-amber-50 text-amber-500 cursor-pointer hover:opacity-80 transition-opacity'
                          }`} title={chatProvider?.format === 'anthropic' ? 'messages' : 'Click to toggle apiType'}>{chatProvider?.format === 'anthropic' ? 'msg' : m.apiType}</button>
                        <span className="truncate">{m.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {showSessionList ? (
            <div className="flex-1 overflow-y-auto">
              {chatSessions.length === 0 ? (
                <div className="text-center text-[11px] text-slate-400 py-8">No chat history</div>
              ) : (
                chatSessions.map(s => (
                  <div
                    key={s.id}
                    className={`group flex items-center gap-2 px-4 py-2 border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                      s.id === activeSessionId ? 'bg-blue-50/50' : ''
                    }`}
                    onClick={() => switchSession(s.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium text-slate-700 truncate">{s.title}</div>
                      <div className="text-[9px] text-slate-400">{new Date(s.updatedAt).toLocaleString()}</div>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); deleteSession(s.id) }}
                      className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <svg className="w-2.5 h-2.5 text-slate-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                {chatMessages.length === 0 && (
                  <div className="text-center text-[11px] text-slate-400 py-8">
                    Start a conversation with {chatProvider?.name || 'AI'}
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] px-3 py-2 rounded-xl text-[12px] leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-blue-500 text-white rounded-br-sm'
                        : 'bg-white ring-1 ring-slate-200 text-slate-700 rounded-bl-sm'
                    }`}>
                      <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                    </div>
                  </div>
                ))}
                {chatError && (
                  <div className="text-center text-[11px] text-red-500 py-2">{chatError}</div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="shrink-0 px-3 pb-3 pt-2 border-t border-slate-200/60">
                {chatAttachment && (
                  <div className="flex items-center gap-2 mb-2 px-2.5 py-1.5 bg-blue-50 rounded-lg ring-1 ring-blue-200">
                    <svg className="w-3.5 h-3.5 text-blue-500 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                    <span className="flex-1 text-[10px] text-blue-700 font-medium truncate">{chatAttachment.name}</span>
                    <button onClick={removeAttachment} className="w-4 h-4 flex items-center justify-center rounded hover:bg-blue-100 transition-colors">
                      <svg className="w-2.5 h-2.5 text-blue-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                )}
                <div className="flex gap-1.5 items-end">
                  <button
                    onClick={clearChat}
                    disabled={chatMessages.length === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border-2 border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-all disabled:opacity-30 disabled:hover:border-slate-200 shrink-0"
                    title="Clear chat"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                  </button>
                  <div className="flex-1 relative flex items-end bg-white border-2 border-slate-200 rounded-lg focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                    <label className="w-8 h-8 flex items-center justify-center cursor-pointer shrink-0">
                      <svg className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600 transition-colors" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
                      <input type="file" accept=".txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.html,.css,.xml,.yaml,.yml,.csv,.log" onChange={handleAttachmentSelect} className="hidden" />
                    </label>
                    <textarea
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={handleChatKeyDown}
                      placeholder="Type a message..."
                      rows={1}
                      className="flex-1 py-2 pr-2 text-[12px] bg-transparent focus:outline-none text-slate-800 placeholder:text-slate-400 resize-none"
                      style={{ minHeight: '32px', maxHeight: '100px' }}
                    />
                  </div>
                  <button
                    onClick={handleChatSend}
                    disabled={(!chatInput.trim() && !chatAttachment) || chatStreaming || !chatProvider}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-30 transition-colors shrink-0 shadow-sm"
                  >
                    {chatStreaming ? (
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div
        className={`absolute inset-0 bg-[#f8f9fb] z-10 transform transition-transform duration-200 ease-out shadow-xl ${
          showPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="px-4 pt-4 pb-3 h-full flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[14px] font-bold text-slate-900 tracking-tight">
              {editingRouterFormat ? 'Router Provider' : editingProvider ? 'Edit Provider' : 'New Provider'}
            </span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={handleProviderQuickImport} disabled={providerImporting || editingRouterFormat !== null}
                title="仅支持linux.do网站"
                className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200/60 rounded-lg disabled:opacity-50 transition-colors">
                {providerImporting ? (
                  <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                ) : (
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                )}
                {providerImporting ? '导入中...' : '一键导入'}
              </button>
              <button aria-label="Close provider editor" onClick={closePanel} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          {providerImportError && (
            <div className="mb-2 text-[9px] text-red-500 bg-red-50 px-2 py-1 rounded">{providerImportError}</div>
          )}

          {editingRouterFormat && (
            <p className="mb-2 px-2 py-1.5 text-[10px] text-purple-600 bg-purple-50 rounded-lg">
              {editingRouterFormat === 'anthropic' ? 'Messages' : editingRouterFormat === 'deepseek' ? 'Chat Completions / Responses / Messages' : 'Chat Completions / Responses'} via Router · Upstream: {editingProvider?.format || 'openai'}. 格式和模型类型由 Router 自动生成；配置修改请使用“编辑原生 Provider”。
            </p>
          )}

          <form aria-label="Provider settings" onSubmit={handleSave} className="flex-1 flex flex-col gap-3 min-h-0">
            <fieldset disabled={editingRouterFormat !== null} className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0 min-w-0">
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Name</label>
                <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
                  className="w-full px-3 py-1.5 text-[12px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                  placeholder="OpenAI" required />
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Format</label>
                <select value={formFormat} onChange={e => handleFormFormatChange(e.target.value as ProviderFormat)}
                  className="w-full px-3 py-1.5 text-[12px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800">
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="deepseek">DeepSeek Harness</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-[11px] font-semibold text-slate-600">格式转换</span>
                  <p id="provider-format-conversion-help" className="text-[9px] text-slate-400">由 Router 提供 Chat Completions / Responses / Messages；需开启全局 Router</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Provider format conversion"
                  aria-describedby="provider-format-conversion-help"
                  aria-checked={formFormatConversionEnabled}
                  disabled={routingBusy}
                  onClick={() => setFormFormatConversionEnabled(!formFormatConversionEnabled)}
                  className={`relative w-8 h-4 shrink-0 rounded-full transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 ${formFormatConversionEnabled ? 'bg-purple-500' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${formFormatConversionEnabled ? 'translate-x-4' : ''}`} />
                </button>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Base URL</label>
                <input type="url" value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)}
                  className="w-full px-3 py-1.5 text-[12px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                  placeholder={formFormat === 'anthropic' ? 'https://api.anthropic.com' : formFormat === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'} required />
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Group</label>
                {groupEditing ? (
                  <div className="flex gap-1">
                    <input type="text" value={groupNewName} onChange={e => setGroupNewName(e.target.value)}
                      className="flex-1 px-3 py-1.5 text-[12px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800"
                      placeholder="New group name" />
                    <button type="button" onClick={() => {
                      const name = groupNewName.trim()
                      if (name && !groupOptions.includes(name)) {
                        setFormGroupApiKeys(prev => ({ ...prev, [name]: '' }))
                        setFormGroupModels(prev => ({ ...prev, [formActiveGroup]: formModels, [name]: [] }))
                      }
                      if (name) {
                        setFormActiveGroup(name)
                        setFormApiKey('')
                        setFormModels([])
                        setFormTestModel('')
                        setFormModelFilter('any')
                        setFormModelSearch('')
                      }
                      setGroupNewName('')
                      setGroupEditing(false)
                    }}
                      className="px-2 py-1 text-[10px] font-semibold text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors">Add</button>
                    <button type="button" onClick={() => { setGroupNewName(''); setGroupEditing(false) }}
                      className="px-2 py-1 text-[10px] font-semibold text-slate-500 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">Cancel</button>
                  </div>
                ) : (
                  <div className="flex gap-1 relative">
                    <div className="flex-1" ref={groupDropdownRef}>
                      <div className="w-full px-3 py-1.5 text-[12px] bg-white border border-slate-300 rounded-lg flex items-center justify-between hover:border-slate-400 transition-all text-slate-800 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
                        <span onDoubleClick={() => {
                          if (formActiveGroup === 'default') return
                          setGroupRenamingTarget(formActiveGroup)
                          setGroupRenameValue(formActiveGroup)
                          setGroupRenaming(true)
                        }}>{formActiveGroup}</span>
                        <button type="button" onClick={() => setGroupDropdownOpen(v => !v)}
                          className="ml-1 p-0.5 rounded hover:bg-slate-100 transition-colors">
                          <svg className="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                        </button>
                      </div>
                      {groupDropdownOpen && (
                        <div className="absolute z-20 left-0 top-full mt-0.5 w-[calc(100%-52px)] bg-white border border-slate-200 rounded-lg shadow-lg py-0.5 max-h-40 overflow-y-auto">
                          {groupOptions.map(g => (
                            <div key={g}
                              onClick={() => {
                                setFormGroupModels(prev => ({ ...prev, [formActiveGroup]: formModels }))
                                setFormActiveGroup(g)
                                setFormApiKey(formGroupApiKeys[g] || '')
                                const groupModels = formGroupModels[g] || []
                                setFormModels(groupModels)
                                setFormTestModel(groupModels[0]?.name || '')
                                setFormModelFilter('any')
                                setFormModelSearch('')
                                setGroupDropdownOpen(false)
                              }}
                              onDoubleClick={() => {
                                if (g === 'default') return
                                setGroupRenamingTarget(g)
                                setGroupRenameValue(g)
                                setGroupRenaming(true)
                                setGroupDropdownOpen(false)
                              }}
                              className={`px-3 py-1.5 text-[12px] cursor-pointer flex items-center justify-between ${
                                g === formActiveGroup ? 'bg-blue-50 text-blue-600 font-medium' : 'text-slate-700 hover:bg-slate-50'
                              }`}>
                              <span>{g}</span>
                              {g !== 'default' && (
                                <svg className="w-2.5 h-2.5 text-slate-300 opacity-0 group-hover:opacity-100" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {groupRenaming && (
                      <input type="text" value={groupRenameValue} onChange={e => setGroupRenameValue(e.target.value)}
                        className="absolute z-30 left-0 top-0 flex-1 w-[calc(100%-52px)] px-3 py-1.5 text-[12px] bg-white border border-blue-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all text-slate-800"
                        autoFocus
                        placeholder={groupRenamingTarget}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            const newName = groupRenameValue.trim()
                            if (newName && newName !== groupRenamingTarget && !groupOptions.includes(newName)) {
                              const nextKeys = { ...formGroupApiKeys }
                              nextKeys[newName] = nextKeys[groupRenamingTarget]
                              delete nextKeys[groupRenamingTarget]
                              const nextModels = { ...formGroupModels }
                              nextModels[newName] = nextModels[groupRenamingTarget]
                              delete nextModels[groupRenamingTarget]
                              setFormGroupApiKeys(nextKeys)
                              setFormGroupModels(nextModels)
                              if (formActiveGroup === groupRenamingTarget) {
                                setFormActiveGroup(newName)
                              }
                            }
                            setGroupRenaming(false)
                          } else if (e.key === 'Escape') {
                            setGroupRenaming(false)
                          }
                        }}
                        onBlur={() => setGroupRenaming(false)}
                      />
                    )}
                    <button type="button" onClick={() => setGroupEditing(true)}
                      className="px-2 py-1 text-[10px] font-semibold text-slate-500 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
                      title="Add group">+</button>
                    <button type="button" onClick={() => {
                      if (formActiveGroup === 'default') return
                      const nextKeys = { ...formGroupApiKeys }
                      delete nextKeys[formActiveGroup]
                      const nextModels = { ...formGroupModels }
                      delete nextModels[formActiveGroup]
                      setFormGroupApiKeys(nextKeys)
                      setFormGroupModels(nextModels)
                      setFormActiveGroup('default')
                      setFormApiKey(nextKeys.default || '')
                      setFormModels(nextModels.default || [])
                      setFormTestModel(nextModels.default?.[0]?.name || '')
                      setFormModelFilter('any')
                      setFormModelSearch('')
                    }}
                      className="px-2 py-1 text-[10px] font-semibold text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
                      title="Delete group">-</button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">API Key</label>
                <div className="relative">
                  <input type={showApiKey ? 'text' : 'password'} value={formApiKey} onChange={e => {
                    const val = e.target.value
                    setFormApiKey(val)
                    setFormGroupApiKeys(prev => ({ ...prev, [formActiveGroup]: val }))
                  }}
                    className="w-full px-3 py-1.5 pr-8 text-[12px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                    onBlur={e => {
                      const val = decodeBase64ApiKey(e.currentTarget.value)
                      setFormApiKey(val)
                      setFormGroupApiKeys(prev => ({ ...prev, [formActiveGroup]: val }))
                    }}
                    onPaste={e => {
                      const input = e.currentTarget
                      const pasted = e.clipboardData.getData('text')
                      const value = input.value.slice(0, input.selectionStart ?? 0) + pasted + input.value.slice(input.selectionEnd ?? input.value.length)
                      const decoded = decodeBase64ApiKey(value)
                      if (decoded !== value) {
                        e.preventDefault()
                        setFormApiKey(decoded)
                        setFormGroupApiKeys(prev => ({ ...prev, [formActiveGroup]: decoded }))
                      }
                    }}
                    placeholder="sk-..." />
                  <button type="button" onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
                    {showApiKey ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    )}
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Models</label>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={handleSyncModels} disabled={syncingModels || !formBaseUrl.trim()}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 text-[8px] font-semibold text-blue-500 bg-blue-50 hover:bg-blue-100 rounded transition-colors disabled:opacity-30"
                      title="Sync models from API">
                      {syncingModels ? (
                        <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      ) : (
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                      )}
                      Sync
                    </button>
                    <button type="button" onClick={clearFormModels} disabled={formModels.length === 0}
                      className="flex items-center gap-0.5 px-1.5 py-0.5 text-[8px] font-semibold text-red-500 bg-red-50 hover:bg-red-100 rounded transition-colors disabled:opacity-30"
                      title="Clear current model list">
                      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4h8v2m-9 4l1 10h8l1-10" /></svg>
                      Clear
                    </button>
                  </div>
                </div>
                {syncModelsError && (
                  <div className="mb-1.5 text-[9px] text-red-500 bg-red-50 px-2 py-1 rounded">{syncModelsError}</div>
                )}
                <div className="flex gap-1 mb-1.5">
                  {(formFormat === 'anthropic' ? ['any'] as const : formFormat === 'deepseek' ? ['any', 'chat', 'responses', 'messages', 'both', 'all'] as const : ['any', 'chat', 'responses', 'both'] as const).map(f => (
                    <button key={f} type="button" onClick={() => setFormModelFilter(f)}
                      className={`px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded transition-colors ${
                        formModelFilter === f
                          ? f === 'any' ? 'bg-slate-600 text-white'
                            : f === 'both' ? 'bg-purple-500 text-white'
                            : f === 'responses' ? 'bg-blue-500 text-white'
                            : 'bg-amber-500 text-white'
                          : f === 'any' ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                            : f === 'both' ? 'bg-purple-50 text-purple-400 hover:bg-purple-100'
                            : f === 'responses' ? 'bg-blue-50 text-blue-400 hover:bg-blue-100'
                            : 'bg-amber-50 text-amber-400 hover:bg-amber-100'
                      }`}>{f === 'any' ? 'All' : f}</button>
                  ))}
                </div>
                <div className="relative mb-1.5">
                  <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-300 pointer-events-none" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35m1.85-5.15a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <input type="search" value={formModelSearch} onChange={e => setFormModelSearch(e.target.value)}
                    className="w-full pl-7 pr-7 py-1.5 text-[11px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                    placeholder="Search models..." />
                  {formModelSearch && (
                    <button type="button" onClick={() => setFormModelSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                      title="Clear search">
                      <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
                <div className="space-y-1">
                  {formModels.length === 0 && (
                    <div className="text-[10px] text-slate-400 py-2 text-center">No models added</div>
                  )}
                  {(() => {
                    const search = formModelSearch.trim().toLowerCase()
                    const filtered = formModels.filter(m =>
                      (formModelFilter === 'any' || m.apiType === formModelFilter)
                      && (!search || m.name.toLowerCase().includes(search))
                    )
                    const sorted = [...filtered].sort((a, b) => {
                      if (a.name === formTestModel) return -1
                      if (b.name === formTestModel) return 1
                      return 0
                    })
                    if (formModels.length > 0 && sorted.length === 0) {
                      return <div className="text-[10px] text-slate-400 py-2 text-center">No matching models</div>
                    }
                    return sorted.map((m) => (
                    <div key={m.name} className="flex items-center gap-1.5">
                      {editingModelName === m.name ? (
                        <input type="text" value={editingModelValue}
                          onChange={e => setEditingModelValue(e.target.value)}
                          onBlur={() => {
                            const v = editingModelValue.trim()
                            if (v && v !== m.name && !formModels.some(x => x.name === v)) {
                              setFormModels(normalizeModelsForFormat(formModels.map(x => x.name === m.name ? { ...x, name: v, format: formFormat } : x), formFormat, defaultApiTypeForFormat(formFormat)))
                              if (formTestModel === m.name) setFormTestModel(v)
                            }
                            setEditingModelName(null)
                          }}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setEditingModelName(null) } }}
                          className="flex-1 px-2 py-1 text-[11px] font-mono border border-blue-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100"
                          autoFocus />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setFormTestModel(m.name)}
                          onDoubleClick={() => { setEditingModelName(m.name); setEditingModelValue(m.name) }}
                          className={`flex-1 px-3 py-1.5 text-[11px] font-mono border rounded-lg text-left transition-all flex items-center gap-1.5 ${
                            m.name === formTestModel
                              ? 'border-emerald-400 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                              : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => { if (formFormat !== 'anthropic') toggleModelApiType(m.name) }}
                            className={`shrink-0 px-1 py-px text-[6px] font-bold uppercase tracking-wider rounded ${
                              formFormat === 'anthropic' ? 'bg-orange-50 text-orange-500 cursor-default'
                                : m.apiType === 'both' ? 'bg-purple-50 text-purple-500 cursor-pointer hover:opacity-80 transition-opacity'
                                : m.apiType === 'responses' ? 'bg-blue-50 text-blue-500 cursor-pointer hover:opacity-80 transition-opacity'
                                : 'bg-amber-50 text-amber-500 cursor-pointer hover:opacity-80 transition-opacity'
                            }`} title={formFormat === 'anthropic' ? 'messages' : 'Click to toggle apiType'}>{formFormat === 'anthropic' ? (editingRouterFormat ? 'messages' : 'msg') : m.apiType}</button>
                          <span className="truncate">{m.name}</span>
                          {m.name === sorted[0]?.name && <span className="text-[8px] text-emerald-400 ml-1 font-semibold">default</span>}
                        </button>
                      )}
                      <button type="button" onClick={() => removeFormModel(m.name)}
                        className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors">
                        <svg className="w-2.5 h-2.5 text-slate-300 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))
                  })()}

                  <div className="flex gap-1.5">
                    <input type="text" value={formNewModel} onChange={e => setFormNewModel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFormModel() } }}
                      className="flex-1 px-3 py-1.5 text-[11px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                      placeholder="Add model..." />
                    {formFormat !== 'anthropic' && (
                      <select value={formNewModelApiType} onChange={e => setFormNewModelApiType(e.target.value as ApiType)}
                        className="px-1.5 py-1 text-[9px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400">
                        <option value="chat">Chat</option>
                        <option value="responses">Resp</option>
                        <option value="both">Both</option>
                      {formFormat === 'deepseek' && <option value="messages">Messages</option>}
                      {formFormat === 'deepseek' && <option value="all">All three</option>}
                      </select>
                    )}
                    <button type="button" onClick={addFormModel} disabled={!formNewModel.trim()}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-30 transition-colors shrink-0">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            </fieldset>

            <div className="shrink-0 flex flex-col gap-2 pt-2 border-t border-slate-200/60">
              {editingRouterFormat ? (
                <div>
                  <label htmlFor="router-test-model" className="text-[11px] font-semibold text-slate-600">Test model</label>
                  <select id="router-test-model" value={formTestModel} disabled={formTesting || routerTestModels.length === 0}
                    onChange={event => { setFormTestModel(event.target.value); setFormTestResult(null); setExpandedEndpoint(null) }}
                    className="mt-1 w-full px-3 py-1.5 text-[11px] border border-slate-300 rounded-lg bg-white disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-100">
                    {routerTestModels.length === 0 && <option value="">No models available</option>}
                    {routerTestModels.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                  <p className="mt-1 text-[9px] text-slate-400">Via Router · {editingRouterFormat === 'anthropic' ? 'Messages' : editingRouterFormat === 'deepseek' ? 'Chat Completions / Responses / Messages' : 'Chat Completions / Responses'} · Native Host required</p>
                </div>
              ) : (
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-[11px] font-semibold text-slate-600">Test via router</span>
                  <p id="model-test-router-help" className="text-[9px] text-slate-400">Model test only · Native Host required</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="Model test routing"
                  aria-describedby="model-test-router-help"
                  aria-checked={formTestViaRouter}
                  disabled={formTesting}
                  onClick={() => { setFormTestViaRouter(!formTestViaRouter); setFormTestResult(null); setExpandedEndpoint(null) }}
                  className={`w-8 h-4 shrink-0 rounded-full transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${formTestViaRouter ? 'bg-emerald-500' : 'bg-slate-300'}`}
                >
                  <span className={`block w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${formTestViaRouter ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
              </div>
              )}
              {formTestResult && (
                <div className="rounded-lg bg-white ring-1 ring-slate-200/60 overflow-hidden">
                  {formTestResult.endpoints && (formTestResult.endpoints.length > 1 || formTestUsesRouter) ? (
                    <>
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100">
                        <span className={`text-[11px] font-mono font-bold ${formTestResult.success ? 'text-emerald-600' : 'text-red-500'}`}>
                          {formTestResult.success ? 'Partial/Full OK' : 'All Failed'}
                        </span>
                      </div>
                      <div className="divide-y divide-slate-50">
                        {formTestResult.endpoints.map(ep => {
                          const isOpen = expandedEndpoint === ep.label
                          const successLabel = ep.convertedFrom
                            ? `OK via ${{ chat: 'Chat', responses: 'Responses', messages: 'Messages' }[ep.convertedFrom]}${ep.nativeStatusCode !== undefined ? ` (native ${ep.nativeStatusCode})` : ''}`
                            : 'OK'
                          return (
                            <div key={ep.label}>
                              <button
                                type="button"
                                onClick={() => setExpandedEndpoint(isOpen ? null : ep.label)}
                                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 transition-colors"
                              >
                                <svg className={`w-2.5 h-2.5 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                                <span className={`shrink-0 text-[7px] font-bold uppercase tracking-wider px-1 py-px rounded ${
                                  ep.label === 'chat' ? 'bg-amber-50 text-amber-600'
                                    : ep.label === 'responses' ? 'bg-blue-50 text-blue-600'
                                    : 'bg-purple-50 text-purple-600'
                                }`}>{ep.label}</span>
                                <span className={`text-[10px] font-mono font-semibold ${ep.success ? 'text-emerald-600' : 'text-red-500'}`}>
                                  {ep.statusCode}
                                </span>
                                <span className="text-[9px] text-slate-400">{ep.success ? successLabel : ep.error}</span>
                              </button>
                              {isOpen && ep.responseBody && (
                                <div className="px-3 py-2 bg-slate-50/50">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[9px] font-semibold text-slate-600">Final {ep.label} response</span>
                                    <button
                                      type="button"
                                      aria-label={`Copy final ${ep.label} response`}
                                      onClick={() => { void copyToClipboard(ep.responseBody || '') }}
                                      className="shrink-0 text-[9px] text-blue-600 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                                    >Copy final response</button>
                                  </div>
                                  <pre className="mt-1 text-[9px] font-mono text-slate-500 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{ep.responseBody}</pre>
                                </div>
                              )}
                              {isOpen && (ep.nativeResponseBody || ep.nativeError) && (
                                <details className="px-3 py-2 bg-amber-50/50 text-[9px]">
                                  <summary className="cursor-pointer text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded">Native {ep.label} diagnostics ({ep.nativeStatusCode})</summary>
                                  <p className="mt-1 text-amber-600">Diagnostics only; not sent to clients.</p>
                                  {ep.nativeError && <p className="mt-1 text-slate-500">{ep.nativeError}</p>}
                                  {ep.nativeResponseBody && <pre className="mt-1 font-mono text-slate-500 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{ep.nativeResponseBody}</pre>}
                                </details>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100">
                      <span className={`text-[11px] font-mono font-bold ${formTestResult.success ? 'text-emerald-600' : 'text-red-500'}`}>
                        {formTestResult.statusCode ?? (formTestResult.success ? 200 : 'ERR')}
                      </span>
                      <span className="text-[10px] text-slate-400">{formTestResult.success ? 'OK' : formTestResult.error || formTestResult.message}</span>
                    </div>
                  )}
                  {formTestResult.responseBody && (!formTestResult.endpoints || (formTestResult.endpoints.length <= 1 && !formTestUsesRouter)) && (
                    <pre className="px-3 py-2 text-[9px] font-mono text-slate-500 bg-slate-50/50 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{formTestResult.responseBody}</pre>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <button type="button" onClick={handleFormTest} disabled={formTesting || !formBaseUrl || !formTestModel}
                  className="px-4 py-2 bg-gradient-to-r from-amber-400 to-orange-500 text-white text-[12px] font-bold rounded-lg hover:from-amber-500 hover:to-orange-600 disabled:opacity-40 transition-all shadow-md shadow-amber-500/20 flex items-center justify-center gap-1.5 shrink-0">
                  {formTesting ? (
                    <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Testing</>
                  ) : (
                    <><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Test</>
                  )}
                </button>
                {editingRouterFormat ? (
                <button type="button" disabled={formTesting} onClick={() => { if (editingProvider) openEdit(editingProvider) }}
                  className="flex-1 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-[12px] font-semibold rounded-lg hover:from-blue-600 hover:to-indigo-700 disabled:opacity-40 transition-all shadow-md shadow-blue-500/20">
                  编辑原生 Provider
                </button>
                ) : (
                <button type="submit" disabled={routingBusy}
                  className="flex-1 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-[12px] font-semibold rounded-lg hover:from-blue-600 hover:to-indigo-700 disabled:opacity-40 transition-all shadow-md shadow-blue-500/20">
                  {saving ? 'Saving...' : 'Save'}
                </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>

      <div
        className={`absolute inset-0 bg-[#f8f9fb] z-10 transform transition-transform duration-200 ease-out shadow-xl ${
          showSettings ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-full flex flex-col">
          <div className="shrink-0 px-4 pt-4 pb-2 border-b border-slate-200/60">
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-bold text-slate-900 tracking-tight">Site Management</span>
              <button onClick={() => setShowSettings(false)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          </div>

          {addingSite || editingSite ? (
            <div className="flex-1 overflow-hidden px-4 py-3">
              <SiteForm
                onSave={editingSite ? handleUpdateSite : handleAddSite}
                onCancel={() => { setAddingSite(false); setEditingSite(null) }}
                onSyncProvider={handleSyncProvider}
                initialData={editingSite || undefined}
              />
            </div>
          ) : (
            <>
              <div className="shrink-0 px-4 py-2 border-b border-slate-100">
                <button onClick={() => { if (siteListRef.current) siteListScrollPos.current = siteListRef.current.scrollTop; setAddingSite(true) }}
                  className="w-full py-2 text-[11px] font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors flex items-center justify-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                  Add Site
                </button>
              </div>

              <div className="shrink-0 border-b border-slate-100 px-4 py-2">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <svg className="w-3 h-3 text-violet-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.556a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.08" /></svg>
                  <span className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Webhook</span>
                  {webhookEnabled && webhookUrl && (
                    <span className="text-[8px] font-medium px-1 py-px rounded ${
                      webhookUrl.includes('qyapi.weixin.qq.com') ? 'bg-green-50 text-green-600' :
                      webhookUrl.includes('oapi.dingtalk.com') ? 'bg-blue-50 text-blue-600' :
                      webhookUrl.includes('open.feishu.cn') ? 'bg-amber-50 text-amber-600' :
                      'bg-slate-50 text-slate-500'
                    }">{
                      webhookUrl.includes('qyapi.weixin.qq.com') ? '企微' :
                      webhookUrl.includes('oapi.dingtalk.com') ? '钉钉' :
                      webhookUrl.includes('open.feishu.cn') ? '飞书' :
                      '通用'
                    }</span>
                  )}
                  <button
                    onClick={async () => {
                      const newVal = !webhookEnabled
                      setWebhookEnabled(newVal)
                      await chrome.storage.local.set({ webhook_enabled: newVal })
                    }}
                    className={`ml-auto relative w-7 h-4 rounded-full transition-colors ${webhookEnabled ? 'bg-violet-500' : 'bg-slate-200'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${webhookEnabled ? 'translate-x-3' : ''}`} />
                  </button>
                </div>
                {webhookEnabled && (
                  <>
                    <div className="flex gap-1">
                      <input type="text" value={webhookUrl} onChange={async e => {
                        const val = e.target.value
                        setWebhookUrl(val)
                        await chrome.storage.local.set({ webhook_url: val })
                      }}
                        placeholder="https://example.com/webhook"
                        className="flex-1 px-3 py-1.5 text-[11px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100 transition-all text-slate-800" />
                      <button type="button" onClick={async () => {
                        if (!webhookUrl) return
                        setWebhookTesting(true)
                        setWebhookTestResult(null)
                        try {
                          const res = await sendMessage<{ success: boolean; error?: string }>('SEND_WEBHOOK', {
                            sites: [
                              { name: 'Test Site 1', url: 'https://test1.example.com', autoCheckin: true, checkinDate: localDateStr(), checkinStatus: { lastTestTime: Date.now(), isSuccess: true } } as any,
                              { name: 'Test Site 2', url: 'https://test2.example.com', autoCheckin: true, checkinDate: localDateStr(), checkinStatus: { lastTestTime: Date.now(), isSuccess: false, errorMessage: 'Timeout' } } as any,
                              { name: 'Test Site 3', url: 'https://test3.example.com', autoCheckin: false } as any,
                            ],
                            today: localDateStr(),
                          })
                          setWebhookTestResult({ success: res.success, message: res.success ? 'Sent!' : (res.error || 'Failed') })
                        } catch (e) {
                          setWebhookTestResult({ success: false, message: e instanceof Error ? e.message : 'Error' })
                        }
                        setWebhookTesting(false)
                        setTimeout(() => setWebhookTestResult(null), 3000)
                      }}
                        disabled={webhookTesting}
                        className={`px-2 py-1 text-[9px] font-semibold rounded-lg transition-colors shrink-0 ${webhookTesting ? 'text-slate-400 bg-slate-50' : 'text-violet-600 bg-violet-50 hover:bg-violet-100'}`}
                        title="Test webhook">{webhookTesting ? '...' : 'Test'}</button>
                    </div>
                    {webhookTestResult && (
                      <div className={`mt-1 text-[9px] px-2 py-1 rounded ${webhookTestResult.success ? 'text-emerald-600 bg-emerald-50' : 'text-red-500 bg-red-50'}`}>
                        {webhookTestResult.message}
                      </div>
                    )}
                  </>
                )}
              </div>

              {sites.length > 0 && (() => {
                const autoSites = sites.filter(s => s.enabled !== false && s.autoCheckin)
                const disabledSites = sites.filter(s => s.enabled === false || !s.autoCheckin)
                const today = localDateStr()
                const checkedIn = autoSites.filter(s => s.checkinDate === today && s.checkinStatus?.isSuccess).length
                const failed = autoSites.filter(s => s.checkinDate === today && s.checkinStatus && !s.checkinStatus.isSuccess).length
                const total = autoSites.length
                const currentList = checkinTab === 'enabled' ? autoSites : disabledSites
                return (
                <div className="shrink-0 border-b border-slate-100">
                  <button onClick={() => setCheckinExpanded(v => !v)}
                    className="w-full px-4 py-2 flex items-center gap-1.5 hover:bg-slate-50 transition-colors">
                    <svg className={`w-2.5 h-2.5 text-slate-400 transition-transform ${checkinExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                    <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider">Auto Check-in</span>
                    <span className="text-[9px] text-slate-400 ml-auto">{checkedIn}/{total}</span>
                  </button>
                  {checkinExpanded && (
                    <div className="px-4 pb-2">
                      <div className="flex items-center gap-1 mb-1.5">
                        <button onClick={() => setCheckinTab('enabled')}
                          className={`px-2 py-0.5 text-[9px] font-semibold rounded transition-colors ${checkinTab === 'enabled' ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                          已开启 ({autoSites.length})
                        </button>
                        <button onClick={() => setCheckinTab('disabled')}
                          className={`px-2 py-0.5 text-[9px] font-semibold rounded transition-colors ${checkinTab === 'disabled' ? 'bg-slate-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                          未开启 ({disabledSites.length})
                        </button>
                        {checkinTab === 'enabled' && (
                          <button
                            onClick={handleCheckinAll}
                            disabled={checkingInAll || checkedIn === total}
                            className="ml-auto px-2 py-0.5 text-[9px] font-semibold text-white bg-emerald-500 rounded hover:bg-emerald-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                          >
                            {checkingInAll ? (
                              <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                            ) : (
                              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            )}
                            一键签到
                          </button>
                        )}
                      </div>
                      {checkinTab === 'enabled' && (
                        <div className="flex items-center gap-3 mb-1.5 text-[9px] text-slate-500">
                          <span>总数：<span className="font-semibold text-slate-700">{total}</span></span>
                          <span>签到成功：<span className="font-semibold text-emerald-500">{checkedIn}</span></span>
                          <span>签到失败：<span className="font-semibold text-red-400">{failed}</span></span>
                        </div>
                      )}
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {currentList.length === 0 ? (
                          <div className="text-center text-[9px] text-slate-400 py-3">{checkinTab === 'enabled' ? '无已开启签到的站点' : '所有站点均已开启签到'}</div>
                        ) : currentList.map(site => (
                          <div key={site.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg ${checkinTab === 'enabled' ? 'bg-emerald-50/50 ring-1 ring-emerald-200/60' : 'bg-slate-50 ring-1 ring-slate-200/60'}`}>
                            <span className="text-[10px] font-medium text-slate-700 truncate flex-1">{site.name}</span>
                            {checkinTab === 'enabled' && site.checkinTimeRange?.scheduledMinute != null && (
                              <span className="text-[8px] text-blue-400 font-medium">
                                {site.checkinTimeRange.startHour + Math.floor(site.checkinTimeRange.scheduledMinute / 60)}:{String(site.checkinTimeRange.scheduledMinute % 60).padStart(2, '0')}
                              </span>
                            )}
                            {checkinTab === 'enabled' && (
                              <span title={site.checkinStatus ? [
                                    `Status: ${site.checkinStatus.statusCode || (site.checkinStatus.isSuccess ? 'OK' : 'Fail')}`,
                                    site.checkinStatus.errorMessage && `Error: ${site.checkinStatus.errorMessage}`,
                                    site.checkinStatus.responseBody && `Response: ${site.checkinStatus.responseBody.slice(0, 200)}`,
                                  ].filter(Boolean).join('\n') : undefined} className={`text-[8px] font-semibold px-1 py-px rounded ${
                                site.checkinStatus?.isSuccess ? 'bg-emerald-100 text-emerald-600' : site.checkinStatus && !site.checkinStatus.isSuccess ? 'bg-red-100 text-red-500' : 'bg-slate-100 text-slate-400'
                              }`}>
                                {site.checkinStatus?.isSuccess ? 'Done' : site.checkinStatus && !site.checkinStatus.isSuccess ? 'Failed' : 'Pending'}
                              </span>
                            )}
                            {checkinTab === 'enabled' && (
                              <button
                                onClick={() => handleCheckinSite(site)}
                                disabled={checkingInSiteId === site.id}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-emerald-100 transition-colors disabled:opacity-40"
                                title="Manual check-in"
                              >
                                {checkingInSiteId === site.id ? (
                                  <svg className="w-2.5 h-2.5 animate-spin text-emerald-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                ) : (
                                  <svg className="w-2.5 h-2.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                                )}
                              </button>
                            )}
                            {checkinTab === 'disabled' && (
                              <button
                                onClick={async () => {
                                  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true })
                                  await chrome.tabs.create({ url: site.url, index: currentTab ? currentTab.index + 1 : undefined })
                                }}
                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                                title="Open site"
                              >
                                <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                )
              })()}

              {sites.length > 0 && (
                <div className="shrink-0 px-4 py-2 border-b border-slate-100">
                  {!siteManageMode ? (
                    <button
                      onClick={() => setSiteManageMode(true)}
                      className="group w-full px-3 py-2 text-[10px] font-semibold text-white bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 rounded-lg hover:from-blue-600 hover:via-indigo-600 hover:to-violet-600 active:scale-[0.99] transition-all shadow-sm shadow-indigo-500/25 flex items-center justify-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5 transition-transform group-hover:scale-110" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h10" />
                        <circle cx="17" cy="17" r="3" />
                        <path strokeLinecap="round" d="M17 15.5v3M15.5 17h3" />
                      </svg>
                      <span>管理站点</span>
                      <span className="px-1.5 py-px text-[8px] font-bold rounded-full bg-white/20 ring-1 ring-white/25">
                        {sites.length}
                      </span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setSelectedSiteIds(selectedSiteIds.length === sites.length ? [] : sites.map(site => site.id))}
                        className="px-2 py-1 text-[9px] font-medium text-slate-600 bg-slate-50 rounded-md hover:bg-slate-100"
                      >
                        {selectedSiteIds.length === sites.length ? '取消全选' : '全选'}
                      </button>
                      <span className="text-[9px] text-slate-400 whitespace-nowrap">已选 {selectedSiteIds.length}</span>
                      <button onClick={() => handleBulkSiteAction('enable')} disabled={!selectedSiteIds.length} className="px-2 py-1 text-[9px] font-medium text-emerald-600 bg-emerald-50 rounded-md hover:bg-emerald-100 disabled:opacity-40">启用</button>
                      <button onClick={() => handleBulkSiteAction('disable')} disabled={!selectedSiteIds.length} className="px-2 py-1 text-[9px] font-medium text-amber-600 bg-amber-50 rounded-md hover:bg-amber-100 disabled:opacity-40">禁用</button>
                      <button onClick={() => handleBulkSiteAction('delete')} disabled={!selectedSiteIds.length} className="px-2 py-1 text-[9px] font-medium text-red-500 bg-red-50 rounded-md hover:bg-red-100 disabled:opacity-40">移除</button>
                      <button onClick={() => { setSelectedSiteIds([]); setSiteManageMode(false) }} className="ml-auto px-2 py-1 text-[9px] font-medium text-slate-500 hover:text-slate-700">完成</button>
                    </div>
                  )}
                </div>
              )}

              <div ref={siteListRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {sites.length === 0 ? (
                  <div className="text-center text-[11px] text-slate-400 py-8">No sites added yet</div>
                ) : sites.map(site => {
                  const isDragging = siteDragId === site.id
                  const isBeforeTarget = siteDragOverId !== null && !isDragging && (() => {
                    const ids = sites.map(s => s.id)
                    const dragIdx = ids.indexOf(siteDragId!)
                    const overIdx = ids.indexOf(siteDragOverId!)
                    const currentIdx = ids.indexOf(site.id)
                    if (dragIdx < overIdx) return currentIdx > dragIdx && currentIdx <= overIdx
                    if (dragIdx > overIdx) return currentIdx >= overIdx && currentIdx < dragIdx
                    return false
                  })()
                  return (
                  <div
                    key={site.id}
                    draggable
                    onDragStart={() => setSiteDragId(site.id)}
                    onDragOver={e => { e.preventDefault(); setSiteDragOverId(site.id) }}
                    onDragLeave={() => { if (siteDragOverId === site.id) setSiteDragOverId(null) }}
                    onDrop={() => handleSiteDrop(site.id)}
                    onDragEnd={() => { setSiteDragId(null); setSiteDragOverId(null) }}
                    className={`transition-all duration-200 ${isDragging ? 'opacity-30 scale-[0.98]' : ''} ${siteDragOverId === site.id && siteDragId !== site.id ? 'ring-2 ring-blue-400 rounded-xl' : ''} ${isBeforeTarget && siteDragId !== null ? 'translate-y-1' : ''}`}
                  >
                    <SiteCard
                      site={site}
                      onTest={id => handleTestSite(sites.find(s => s.id === id)!)}
                      onCheckin={id => handleCheckinSite(sites.find(s => s.id === id)!)}
                      onEdit={s => { if (siteListRef.current) siteListScrollPos.current = siteListRef.current.scrollTop; setEditingSite(s) }}
                      onDelete={handleDeleteSite}
                      onRefreshBalance={refreshSiteBalance}
                      onToggleEnabled={handleToggleSiteEnabled}
                      manageMode={siteManageMode}
                      selected={selectedSiteIds.includes(site.id)}
                      onSelect={toggleSiteSelection}
                      testing={testingSiteId === site.id}
                      checkingIn={checkingInSiteId === site.id}
                      refreshingBalance={refreshingSiteId === site.id}
                    />
                  </div>
                )})}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
