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
    <div className="relative h-full bg-[#fafafa]">
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-zinc-900 tracking-tight">CodexSwitch</span>
          <div className="flex items-center gap-0.5">
            <label className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-zinc-100 cursor-pointer transition-colors">
              <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={handleExport} disabled={providers.length === 0} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-zinc-100 transition-colors disabled:opacity-30">
              <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            </button>
            <button onClick={openAdd} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-blue-50 text-blue-500 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
        </div>
      </div>

      {/* Active provider bar */}
      {activeProvider && (
        <div className="mx-4 mb-2 px-3 py-2 bg-white rounded-lg border border-zinc-200/80">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-zinc-800 truncate">{activeProvider.name}</div>
              <div className="text-[11px] text-zinc-400 font-mono truncate">{activeProvider.baseUrl}</div>
            </div>
            <StatusBadge status={activeProvider.testStatus} />
          </div>
        </div>
      )}

      {/* Provider list */}
      <div className="px-4 space-y-1 max-h-72 overflow-y-auto">
        {providers.length === 0 ? (
          <div className="text-[12px] text-zinc-300 text-center py-12">No providers</div>
        ) : (
          providers.map(p => (
            <div
              key={p.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-lg border transition-all duration-150 cursor-pointer ${
                p.isActive
                  ? 'bg-white border-blue-200 shadow-sm'
                  : 'bg-white border-transparent hover:border-zinc-200'
              }`}
              onClick={() => handleSetActive(p.id)}
            >
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.isActive ? 'bg-blue-500' : 'bg-zinc-200'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-zinc-700 truncate">{p.name}</div>
                <div className="text-[10px] text-zinc-400 font-mono truncate">{p.model}</div>
              </div>
              <StatusBadge status={p.testStatus} />
              <div className="flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                <button
                  onClick={e => { e.stopPropagation(); handleTest(p.id) }}
                  disabled={testing !== null}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-100 transition-colors disabled:opacity-30"
                >
                  {testing === p.id ? (
                    <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  ) : (
                    <svg className="w-3 h-3 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  )}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); openEdit(p) }}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-zinc-100 transition-colors"
                >
                  <svg className="w-3 h-3 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                </button>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(p.id) }}
                  className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-50 transition-colors"
                >
                  <svg className="w-3 h-3 text-zinc-300 hover:text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Slide-out panel */}
      <div
        className={`absolute inset-0 bg-white z-10 transform transition-transform duration-200 ease-out shadow-lg ${
          showPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-5 h-full flex flex-col">
          <div className="flex items-center justify-between mb-5">
            <span className="text-[13px] font-semibold text-zinc-900 tracking-tight">
              {editingProvider ? 'Edit' : 'New Provider'}
            </span>
            <button onClick={closePanel} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-zinc-100 transition-colors">
              <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          <form onSubmit={handleSave} className="flex-1 flex flex-col gap-4">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">Name</label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                className="w-full px-3 py-2 text-[13px] border border-zinc-200 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-colors bg-white"
                placeholder="OpenAI"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">Base URL</label>
              <input
                type="url"
                value={formBaseUrl}
                onChange={e => setFormBaseUrl(e.target.value)}
                className="w-full px-3 py-2 text-[13px] font-mono border border-zinc-200 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-colors bg-white"
                placeholder="https://api.openai.com"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">API Key</label>
              <div className="flex gap-1.5">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={formApiKey}
                  onChange={e => setFormApiKey(e.target.value)}
                  className="flex-1 px-3 py-2 text-[13px] font-mono border border-zinc-200 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-colors bg-white"
                  placeholder="sk-..."
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="px-2.5 py-2 text-[11px] text-zinc-400 border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors"
                >
                  {showApiKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 uppercase tracking-wider">Model</label>
              <input
                type="text"
                value={formModel}
                onChange={e => setFormModel(e.target.value)}
                className="w-full px-3 py-2 text-[13px] font-mono border border-zinc-200 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-colors bg-white"
                placeholder="gpt-3.5-turbo"
                required
              />
            </div>

            <div className="mt-auto pt-4">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-2.5 bg-zinc-900 text-white text-[13px] font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 transition-colors"
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
