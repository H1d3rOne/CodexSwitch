import React, { useState, useEffect, useRef } from 'react'
import type { Provider, TestResult, ChatMessage, ChatSession } from '../types'
import { StatusBadge } from '../components/StatusBadge'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text) } catch {}
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testingAll, setTestingAll] = useState(false)
  const [showPanel, setShowPanel] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)

  const [formName, setFormName] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formModels, setFormModels] = useState<string[]>([])
  const [formNewModel, setFormNewModel] = useState('')
  const [formTestModel, setFormTestModel] = useState<string>('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formTesting, setFormTesting] = useState(false)
  const [formTestResult, setFormTestResult] = useState<TestResult | null>(null)

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

  const dropdownRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadProviders() }, [])

  useEffect(() => {
    async function loadSyncState() {
      const res = await chrome.storage.local.get(['sync_enabled'])
      setSyncEnabled(res.sync_enabled !== false)
    }
    loadSyncState()
  }, [])

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

  async function loadChatSessions() {
    const res = await sendMessage<{ success: boolean; data: { sessions: ChatSession[]; activeId: string | null } }>('GET_CHAT_SESSIONS')
    if (res.success && res.data) {
      setChatSessions(res.data.sessions)
      setActiveSessionId(res.data.activeId)
    }
  }

  async function loadProviders() {
    const res = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (res.success) {
      const list = res.data.map(p => ({
        ...p,
        models: Array.isArray(p.models) && p.models.length > 0 ? p.models : [p.model],
      }))
      setProviders(list)
      setActiveProvider(list.find(p => p.isActive) || null)
    }
  }

  async function handleSetActive(id: string) {
    if (selectMode) return
    await sendMessage('SET_ACTIVE_PROVIDER', { id, sync: syncEnabled })
    await loadProviders()
  }

  async function handleToggleSync() {
    const newVal = !syncEnabled
    setSyncEnabled(newVal)
    await chrome.storage.local.set({ sync_enabled: newVal })
  }

  async function handleExport() {
    const res = await sendMessage<{ success: boolean; data: string }>('EXPORT_PROVIDERS')
    if (res.success && res.data) {
      const blob = new Blob([res.data], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `codexswitch-export-${new Date().toISOString().slice(0,10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  function handleImportClick() {
    importInputRef.current?.click()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      await sendMessage('IMPORT_PROVIDERS', data)
      await loadProviders()
    } catch {
      alert('Invalid config file')
    }
    if (importInputRef.current) importInputRef.current.value = ''
  }


  async function handleTest(id: string) {
    setTesting(id)
    const p = providers.find(p => p.id === id)
    if (p) { await sendMessage('TEST_PROVIDER', p); await loadProviders() }
    setTesting(null)
  }

  async function handleTestAll() {
    setTestingAll(true)
    await Promise.all(providers.map(p => sendMessage('TEST_PROVIDER', p)))
    await loadProviders()
    setTestingAll(false)
  }

  async function handleSwitchModel(id: string, model: string) {
    await sendMessage('UPDATE_PROVIDER', { id, updates: { model } })
    setOpenDropdownId(null)
    await loadProviders()
  }

  function openAdd() {
    setEditingProvider(null)
    setFormName(''); setFormBaseUrl(''); setFormApiKey(''); setFormModels([])
    setFormNewModel(''); setFormTestModel(''); setFormTestResult(null)
    setShowPanel(true)
  }

  function openEdit(p: Provider) {
    setEditingProvider(p)
    setFormName(p.name); setFormBaseUrl(p.baseUrl); setFormApiKey(p.apiKey)
    setFormModels(p.models || [p.model]); setFormNewModel('')
    setFormTestModel(p.model); setFormTestResult(null)
    setShowPanel(true)
  }

  function closePanel() { setShowPanel(false); setEditingProvider(null); setFormTestResult(null) }

  function addFormModel() {
    const m = formNewModel.trim()
    if (m && !formModels.includes(m)) {
      const newModels = [...formModels, m]
      setFormModels(newModels)
      setFormNewModel('')
      if (!formTestModel) setFormTestModel(m)
    }
  }

  function removeFormModel(m: string) {
    if (formModels.length <= 1) return
    const newModels = formModels.filter(x => x !== m)
    setFormModels(newModels)
    if (formTestModel === m) {
      setFormTestModel(newModels[0] || '')
    }
  }

  async function handleFormTest() {
    if (!formTestModel) return
    setFormTesting(true); setFormTestResult(null)
    try {
      const tempProvider = { id: 'temp', name: '', baseUrl: formBaseUrl, apiKey: formApiKey, model: formTestModel, models: [], isActive: false, createdAt: 0, updatedAt: 0 }
      const res = await sendMessage<{ success: boolean; data?: TestResult }>('TEST_PROVIDER', tempProvider)
      if (res.success && res.data) {
        setFormTestResult(res.data)
        if (res.data.correctedBaseUrl) setFormBaseUrl(res.data.correctedBaseUrl)
      }
    } catch {
      setFormTestResult({ success: false, message: 'Request failed' })
    }
    setFormTesting(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const data = {
      name: formName, baseUrl: formBaseUrl, apiKey: formApiKey,
      model: formModels[0], models: formModels,
      isActive: editingProvider?.isActive || false,
    }
    if (editingProvider) {
      await sendMessage('UPDATE_PROVIDER', { id: editingProvider.id, updates: data })
    } else {
      await sendMessage('ADD_PROVIDER', data)
    }
    closePanel(); await loadProviders(); setSaving(false)
  }

  async function handleDelete(id: string) {
    await sendMessage('DELETE_PROVIDER', id); await loadProviders()
  }

  async function handleDeleteSelected() {
    for (const id of selectedIds) {
      await sendMessage('DELETE_PROVIDER', id)
    }
    setSelectedIds(new Set()); setSelectMode(false); await loadProviders()
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function toggleSelectAll() {
    setSelectedIds(selectedIds.size === providers.length ? new Set() : new Set(providers.map(p => p.id)))
  }

  function exitSelectMode() { setSelectMode(false); setSelectedIds(new Set()) }

  function handleCopy(p: Provider) {
    const text = `Name: ${p.name}\nBase URL: ${p.baseUrl}\nAPI Key: ${p.apiKey}\nModel: ${p.model}\nModels: ${p.models.join(', ')}`
    copyToClipboard(text)
    setCopiedId(p.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const chatProvider = providers.find(p => p.id === chatProviderId)

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
      port.postMessage({ baseUrl: chatProvider.baseUrl, apiKey: chatProvider.apiKey, model: chatModel, messages: newMessages })

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
          <span className="text-[14px] font-bold tracking-tight text-slate-900">CodexSwitch</span>
          <div className="flex items-center gap-0.5">
            <button onClick={openAdd} className="w-7 h-7 flex items-center justify-center rounded-md bg-blue-500 hover:bg-blue-600 text-white shadow-sm shadow-blue-500/20 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
        </div>
      </div>

      {activeProvider && (
        <div className="shrink-0 mx-4 mb-2 px-3 py-2 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 shadow-sm ring-1 ring-blue-200/80">
          <div className="flex items-center gap-1.5 mb-0.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[8px] font-bold text-emerald-500 uppercase tracking-widest">Active</span>
          </div>
          <div className="text-[11px] font-semibold text-slate-800 truncate">{activeProvider.name}</div>
          <div className="text-[9px] text-slate-400 font-mono truncate">{activeProvider.baseUrl}</div>
          <div className="mt-0.5">
            <StatusBadge status={activeProvider.testStatus} loading={testing === activeProvider.id || testingAll} />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="rounded-xl ring-2 ring-slate-300/80 bg-white/60 overflow-visible">
          {providers.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 bg-slate-50/50">
              <button
                onClick={handleTestAll}
                disabled={testingAll || testing !== null}
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
                  <button onClick={toggleSelectAll} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100 ring-1 ring-slate-200/60 transition-colors">
                    {selectedIds.size === providers.length ? 'Deselect' : 'All'}
                  </button>
                  {selectedIds.size > 0 && (
                    <button onClick={handleDeleteSelected} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-red-500 bg-red-50 hover:bg-red-100 ring-1 ring-red-200/60 transition-colors">
                      Del ({selectedIds.size})
                    </button>
                  )}
                  <button onClick={exitSelectMode} className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 transition-colors">
                    <svg className="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </>
              ) : (
                <button onClick={() => setSelectMode(true)} className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold text-slate-500 bg-slate-50 hover:bg-slate-100 ring-1 ring-slate-200/60 transition-colors">
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

          {providers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
                <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>
              </div>
              <span className="text-[10px] text-slate-300">Click + to add a provider</span>
            </div>
          ) : (
            <div className="p-2 space-y-1.5">
              {providers.map(p => (
                <div
                  key={p.id}
                  className={`group rounded-lg ring-2 transition-all duration-150 ${
                    selectMode ? 'cursor-default' : 'cursor-pointer'
                  } ${p.isActive ? 'ring-emerald-400 bg-emerald-50/50 shadow-sm' : 'ring-slate-200 bg-white hover:ring-slate-300'} ${
                    selectMode && selectedIds.has(p.id) ? 'ring-emerald-500 bg-emerald-50/70' : ''
                  }`}
                  onClick={() => selectMode ? toggleSelect(p.id) : handleSetActive(p.id)}
                >
                  <div className="flex items-start gap-2 px-2.5 py-1.5">
                    {selectMode ? (
                      <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${
                        selectedIds.has(p.id) ? 'bg-blue-500 border-blue-500' : 'border-slate-300 bg-white'
                      }`}>
                        {selectedIds.has(p.id) && (
                          <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                        )}
                      </div>
                    ) : (
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 transition-all ${p.isActive ? 'bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.4)]' : 'bg-slate-300'}`} />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-semibold text-slate-700 truncate">{p.name}</div>
                      <div className="text-[9px] text-slate-400 font-mono truncate">{p.baseUrl}</div>
                      <div className="relative inline-block" ref={openDropdownId === p.id ? dropdownRef : undefined}>
                        <button
                          onClick={e => { e.stopPropagation(); setOpenDropdownId(openDropdownId === p.id ? null : p.id) }}
                          className="flex items-center gap-0.5 text-[9px] text-slate-500 font-mono hover:text-blue-500 transition-colors"
                        >
                          <span className="truncate max-w-[100px]">{p.model}</span>
                          {(p.models || []).length > 1 && (
                            <svg className="w-2 h-2 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                          )}
                        </button>
                        {openDropdownId === p.id && (p.models || []).length > 1 && (
                          <div className="absolute left-0 top-full mt-0.5 z-30 bg-white rounded-lg shadow-lg ring-1 ring-slate-200 py-0.5 min-w-max max-h-[72px] overflow-y-auto">
                            {(p.models || []).map(m => (
                              <button
                                key={m}
                                onClick={e => { e.stopPropagation(); handleSwitchModel(p.id, m) }}
                                className={`w-full text-left px-2.5 py-1 text-[10px] font-mono hover:bg-blue-50 transition-colors whitespace-nowrap ${
                                  m === p.model ? 'text-blue-600 font-semibold bg-blue-50/50' : 'text-slate-600'
                                }`}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="mt-0.5">
                        <StatusBadge status={p.testStatus} loading={testing === p.id || testingAll} />
                      </div>
                    </div>
                    {!selectMode && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
                        <button
                          onClick={e => { e.stopPropagation(); handleTest(p.id) }}
                          disabled={testing !== null}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-blue-50 transition-colors disabled:opacity-20"
                        >
                          {testing === p.id ? (
                            <svg className="w-2.5 h-2.5 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          ) : (
                            <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                          )}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleCopy(p) }}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                          title="Copy info"
                        >
                          {copiedId === p.id ? (
                            <svg className="w-2.5 h-2.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                          ) : (
                            <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
                          )}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); openEdit(p) }}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-100 transition-colors"
                        >
                          <svg className="w-2.5 h-2.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); handleDelete(p.id) }}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors"
                        >
                          <svg className="w-2.5 h-2.5 text-slate-300" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 py-2 border-t border-slate-200/60 bg-white/80 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-slate-400">{providers.length} provider{providers.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-1.5">
            <input ref={importInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden" />
            <button onClick={handleImportClick}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold text-emerald-600 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200/60 transition-colors">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              Import
            </button>
            <button onClick={handleExport} disabled={providers.length === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200/60 transition-colors disabled:opacity-30">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Export
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
              <select
                value={chatProviderId}
                onChange={e => {
                  const p = providers.find(x => x.id === e.target.value)
                  if (p) { setChatProviderId(p.id); setChatModel(p.model) }
                }}
                className="flex-1 px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 text-slate-700"
              >
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={chatModel}
                onChange={e => setChatModel(e.target.value)}
                className="flex-1 px-2 py-1.5 text-[11px] font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 text-slate-700"
              >
                {(chatProvider?.models || [chatModel]).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
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
              {editingProvider ? 'Edit Provider' : 'New Provider'}
            </span>
            <button onClick={closePanel} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors">
              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form onSubmit={handleSave} className="flex-1 flex flex-col gap-3 min-h-0">
            <div className="flex-1 overflow-y-auto flex flex-col gap-3 min-h-0">
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Name</label>
                <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
                  className="w-full px-3 py-1.5 text-[12px] bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                  placeholder="OpenAI" required />
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Base URL</label>
                <input type="url" value={formBaseUrl} onChange={e => setFormBaseUrl(e.target.value)}
                  className="w-full px-3 py-1.5 text-[12px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                  placeholder="https://api.openai.com/v1" required />
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">API Key</label>
                <div className="relative">
                  <input type={showApiKey ? 'text' : 'password'} value={formApiKey} onChange={e => setFormApiKey(e.target.value)}
                    className="w-full px-3 py-1.5 pr-8 text-[12px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
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
                <label className="block text-[10px] font-semibold text-slate-500 mb-1 uppercase tracking-wider">Models</label>
                <div className="space-y-1">
                  {formModels.length === 0 && (
                    <div className="text-[10px] text-slate-400 py-2 text-center">Add at least one model</div>
                  )}
                  {formModels.map((m, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setFormTestModel(m)}
                        className={`flex-1 px-3 py-1.5 text-[11px] font-mono border rounded-lg text-left transition-all ${
                          m === formTestModel
                            ? 'border-emerald-400 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                        }`}
                      >
                        {m}{i === 0 && <span className="text-[8px] text-blue-400 ml-1">default</span>}
                      </button>
                      <button type="button" onClick={() => removeFormModel(m)}
                        className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-50 transition-colors">
                        <svg className="w-2.5 h-2.5 text-slate-300 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-1.5">
                    <input type="text" value={formNewModel} onChange={e => setFormNewModel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFormModel() } }}
                      className="flex-1 px-3 py-1.5 text-[11px] font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all text-slate-800 placeholder:text-slate-400"
                      placeholder="Add model..." />
                    <button type="button" onClick={addFormModel} disabled={!formNewModel.trim()}
                      className="w-7 h-7 flex items-center justify-center rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-30 transition-colors shrink-0">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 flex flex-col gap-2 pt-2 border-t border-slate-200/60">
              {formTestResult && (
                <div className="rounded-lg bg-white ring-1 ring-slate-200/60 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100">
                    <span className={`text-[11px] font-mono font-bold ${formTestResult.success ? 'text-emerald-600' : 'text-red-500'}`}>
                      {formTestResult.statusCode ?? (formTestResult.success ? 200 : 'ERR')}
                    </span>
                    <span className="text-[10px] text-slate-400">{formTestResult.success ? 'OK' : formTestResult.error}</span>
                  </div>
                  {formTestResult.responseBody && (
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
                <button type="submit" disabled={saving || formModels.length === 0}
                  className="flex-1 py-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white text-[12px] font-semibold rounded-lg hover:from-blue-600 hover:to-indigo-700 disabled:opacity-40 transition-all shadow-md shadow-blue-500/20">
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
