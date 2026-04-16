import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { downloadJSON, readJSONFile, validateExportData } from '../utils/export'
import type { ExportData } from '../types'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [showPanel, setShowPanel] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)

  const [formName, setFormName] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formModel, setFormModel] = useState('gpt-3.5-turbo')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadProviders() }, [])

  async function loadProviders() {
    const res = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (res.success) {
      setProviders(res.data)
      setActiveProvider(res.data.find(p => p.isActive) || null)
    }
  }

  async function handleSetActive(id: string) {
    await sendMessage('SET_ACTIVE_PROVIDER', id)
    await loadProviders()
  }

  async function handleTest(id: string) {
    setTesting(id)
    const p = providers.find(p => p.id === id)
    if (p) { await sendMessage('TEST_PROVIDER', p); await loadProviders() }
    setTesting(null)
  }

  function openAdd() {
    setEditingProvider(null)
    setFormName(''); setFormBaseUrl(''); setFormApiKey(''); setFormModel('gpt-3.5-turbo')
    setShowPanel(true)
  }

  function openEdit(p: Provider) {
    setEditingProvider(p)
    setFormName(p.name); setFormBaseUrl(p.baseUrl); setFormApiKey(p.apiKey); setFormModel(p.model)
    setShowPanel(true)
  }

  function closePanel() { setShowPanel(false); setEditingProvider(null) }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const data = { name: formName, baseUrl: formBaseUrl, apiKey: formApiKey, model: formModel, isActive: editingProvider?.isActive || false }
    if (editingProvider) {
      await sendMessage('UPDATE_PROVIDER', { id: editingProvider.id, updates: data })
      await sendMessage('TEST_PROVIDER', { ...editingProvider, ...data })
    } else {
      const res = await sendMessage<{ success: boolean; data: Provider }>('ADD_PROVIDER', data)
      if (res.success) await sendMessage('TEST_PROVIDER', res.data)
    }
    closePanel(); await loadProviders(); setSaving(false)
  }

  async function handleDelete(id: string) {
    await sendMessage('DELETE_PROVIDER', id); await loadProviders()
  }

  async function handleExport() {
    const res = await sendMessage<{ success: boolean; data: ExportData }>('EXPORT_PROVIDERS')
    if (res.success && res.data) downloadJSON(res.data, `codex-switch-${new Date().toISOString().split('T')[0]}.json`)
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    try {
      const data = await readJSONFile(file)
      const v = validateExportData(data)
      if (!v.valid) return
      await sendMessage('IMPORT_PROVIDERS', data); await loadProviders()
    } catch {}
    e.target.value = ''
  }

  return (
    <div className="relative h-full bg-[#0a0a0b] text-white flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
            </div>
            <span className="text-[14px] font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">CodexSwitch</span>
          </div>
          <div className="flex items-center gap-1">
            <label className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.06] cursor-pointer transition-colors">
              <svg className="w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={handleExport} disabled={providers.length === 0} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.06] transition-colors disabled:opacity-20">
              <svg className="w-3.5 h-3.5 text-white/30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            </button>
            <button onClick={openAdd} className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white/50 hover:text-white transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Active provider */}
      {activeProvider && (
        <div className="shrink-0 mx-4 mb-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-violet-500/10 to-blue-500/10 ring-1 ring-white/[0.06]">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-white/90 truncate">{activeProvider.name}</div>
              <div className="text-[10px] text-white/30 font-mono truncate">{activeProvider.baseUrl}</div>
            </div>
            <StatusBadge status={activeProvider.testStatus} />
          </div>
        </div>
      )}

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-1">
        {providers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <div className="w-10 h-10 rounded-full bg-white/[0.03] flex items-center justify-center">
              <svg className="w-5 h-5 text-white/10" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>
            </div>
            <span className="text-[11px] text-white/15">No providers yet</span>
          </div>
        ) : (
          providers.map(p => (
            <div
              key={p.id}
              className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all duration-150 cursor-pointer ${
                p.isActive
                  ? 'bg-white/[0.06] ring-1 ring-white/[0.08]'
                  : 'hover:bg-white/[0.03]'
              }`}
              onClick={() => handleSetActive(p.id)}
            >
              <div className={`w-2 h-2 rounded-full shrink-0 transition-colors ${p.isActive ? 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.5)]' : 'bg-white/10'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-white/80 truncate">{p.name}</div>
                <div className="text-[10px] text-white/25 font-mono truncate">{p.model} · {p.baseUrl}</div>
              </div>
              <StatusBadge status={p.testStatus} />
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                <button
                  onClick={e => { e.stopPropagation(); handleTest(p.id) }}
                  disabled={testing !== null}
                  className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.08] transition-colors disabled:opacity-20"
                >
                  {testing === p.id ? (
                    <svg className="w-3 h-3 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  ) : (
                    <svg className="w-3 h-3 text-white/30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  )}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); openEdit(p) }}
                  className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/[0.08] transition-colors"
                >
                  <svg className="w-3 h-3 text-white/30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" /></svg>
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(p.id) }}
                  className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-red-500/10 transition-colors"
                >
                  <svg className="w-3 h-3 text-white/20 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Slide-out panel */}
      <div
        className={`absolute inset-0 bg-[#0a0a0b] z-10 transform transition-transform duration-200 ease-out ${
          showPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-5 h-full flex flex-col">
          <div className="flex items-center justify-between mb-6">
            <span className="text-[14px] font-bold text-white/90 tracking-tight">
              {editingProvider ? 'Edit' : 'New Provider'}
            </span>
            <button onClick={closePanel} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/[0.06] transition-colors">
              <svg className="w-4 h-4 text-white/30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form onSubmit={handleSave} className="flex-1 flex flex-col gap-5">
            <div>
              <label className="block text-[10px] font-semibold text-white/25 mb-2 uppercase tracking-widest">Name</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                className="w-full px-3 py-2.5 text-[13px] bg-white/[0.04] border border-white/[0.06] rounded-xl focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors text-white/90 placeholder:text-white/15"
                placeholder="OpenAI"
                required
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-white/25 mb-2 uppercase tracking-widest">Base URL</label>
              <input
                type="url"
                value={formBaseUrl}
                onChange={e => setFormBaseUrl(e.target.value)}
                className="w-full px-3 py-2.5 text-[13px] font-mono bg-white/[0.04] border border-white/[0.06] rounded-xl focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors text-white/90 placeholder:text-white/15"
                placeholder="https://api.openai.com"
                required
              />
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-white/25 mb-2 uppercase tracking-widest">API Key</label>
              <div className="flex gap-2">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={formApiKey}
                  onChange={e => setFormApiKey(e.target.value)}
                  className="flex-1 px-3 py-2.5 text-[13px] font-mono bg-white/[0.04] border border-white/[0.06] rounded-xl focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors text-white/90 placeholder:text-white/15"
                  placeholder="sk-..."
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="px-3 py-2.5 text-[10px] font-semibold text-white/25 bg-white/[0.04] border border-white/[0.06] rounded-xl hover:bg-white/[0.08] transition-colors uppercase tracking-wider"
                >
                  {showApiKey ? 'HIDE' : 'SHOW'}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-semibold text-white/25 mb-2 uppercase tracking-widest">Model</label>
              <input
                type="text"
                value={formModel}
                onChange={e => setFormModel(e.target.value)}
                className="w-full px-3 py-2.5 text-[13px] font-mono bg-white/[0.04] border border-white/[0.06] rounded-xl focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-colors text-white/90 placeholder:text-white/15"
                placeholder="gpt-3.5-turbo"
                required
              />
            </div>

            <div className="mt-auto pt-4">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 bg-gradient-to-r from-violet-600 to-blue-600 text-white text-[13px] font-semibold rounded-xl hover:from-violet-500 hover:to-blue-500 disabled:opacity-30 transition-all shadow-lg shadow-violet-500/20"
              >
                {saving ? 'Saving...' : 'Save & Test'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
