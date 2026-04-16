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

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const response = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (response.success) {
      setProviders(response.data)
      const active = response.data.find(p => p.isActive)
      setActiveProvider(active || null)
    }
  }

  async function handleSetActive(id: string) {
    await sendMessage('SET_ACTIVE_PROVIDER', id)
    await loadProviders()
  }

  async function handleTestProvider(id: string) {
    setTesting(id)
    const provider = providers.find(p => p.id === id)
    if (provider) {
      await sendMessage('TEST_PROVIDER', provider)
      await loadProviders()
    }
    setTesting(null)
  }

  function openAddPanel() {
    setEditingProvider(null)
    setFormName('')
    setFormBaseUrl('')
    setFormApiKey('')
    setFormModel('gpt-3.5-turbo')
    setShowPanel(true)
  }

  function openEditPanel(provider: Provider) {
    setEditingProvider(provider)
    setFormName(provider.name)
    setFormBaseUrl(provider.baseUrl)
    setFormApiKey(provider.apiKey)
    setFormModel(provider.model)
    setShowPanel(true)
  }

  function closePanel() {
    setShowPanel(false)
    setEditingProvider(null)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)

    const data = {
      name: formName,
      baseUrl: formBaseUrl,
      apiKey: formApiKey,
      model: formModel,
      isActive: editingProvider?.isActive || false,
    }

    if (editingProvider) {
      await sendMessage('UPDATE_PROVIDER', { id: editingProvider.id, updates: data })
      await sendMessage('TEST_PROVIDER', { ...editingProvider, ...data })
    } else {
      const response = await sendMessage<{ success: boolean; data: Provider }>('ADD_PROVIDER', data)
      if (response.success) {
        await sendMessage('TEST_PROVIDER', response.data)
      }
    }

    closePanel()
    await loadProviders()
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (confirm('确定要删除这个供应商吗？')) {
      await sendMessage('DELETE_PROVIDER', id)
      await loadProviders()
    }
  }

  async function handleExport() {
    const response = await sendMessage<{ success: boolean; data: ExportData }>('EXPORT_PROVIDERS')
    if (response.success && response.data) {
      downloadJSON(response.data, `codex-switch-${new Date().toISOString().split('T')[0]}.json`)
    }
  }

  async function handleImport(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const data = await readJSONFile(file)
      const validation = validateExportData(data)
      if (!validation.valid) {
        alert(`导入失败：${validation.errors?.join(', ')}`)
        return
      }
      const response = await sendMessage('IMPORT_PROVIDERS', data)
      if (response.success) {
        await loadProviders()
      } else {
        alert(`导入失败：${response.error}`)
      }
    } catch (error) {
      alert(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
    }

    event.target.value = ''
  }

  return (
    <div className="relative h-full">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-base font-bold text-gray-800">CodexSwitch</h1>
          <div className="flex items-center gap-1">
            <label className="p-1.5 rounded hover:bg-gray-100 cursor-pointer" title="导入">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <input type="file" accept=".json" onChange={handleImport} className="hidden" />
            </label>
            <button onClick={handleExport} className="p-1.5 rounded hover:bg-gray-100" title="导出" disabled={providers.length === 0}>
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
            <button onClick={openAddPanel} className="p-1.5 rounded hover:bg-blue-50 text-blue-500" title="添加供应商">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        </div>

        {activeProvider && (
          <div className="bg-blue-50 rounded-lg p-3 mb-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm">{activeProvider.name}</div>
                <div className="text-xs text-gray-500">{activeProvider.baseUrl}</div>
              </div>
              <StatusBadge status={activeProvider.testStatus} />
            </div>
          </div>
        )}

        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {providers.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-8">
              点击 + 添加供应商
            </div>
          ) : (
            providers.map(provider => (
              <div
                key={provider.id}
                className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${
                  provider.isActive ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="radio"
                  name="activeProvider"
                  checked={provider.isActive}
                  onChange={() => handleSetActive(provider.id)}
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleSetActive(provider.id)}>
                  <div className="font-medium text-sm truncate">{provider.name}</div>
                  <div className="text-xs text-gray-500 truncate">{provider.baseUrl}</div>
                  <div className="mt-0.5">
                    <StatusBadge status={provider.testStatus} />
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleTestProvider(provider.id)}
                    disabled={testing !== null}
                    className="p-1 rounded hover:bg-blue-100 text-blue-500 disabled:opacity-50"
                    title="测试"
                  >
                    {testing === provider.id ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={() => openEditPanel(provider)}
                    className="p-1 rounded hover:bg-gray-100 text-gray-500"
                    title="编辑"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleDelete(provider.id)}
                    className="p-1 rounded hover:bg-red-100 text-red-400"
                    title="删除"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div
        className={`absolute inset-0 bg-white z-10 transform transition-transform duration-200 ease-out ${
          showPanel ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="p-4 h-full flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold">
              {editingProvider ? '编辑供应商' : '添加供应商'}
            </h2>
            <button onClick={closePanel} className="p-1 rounded hover:bg-gray-100">
              <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSave} className="flex-1 flex flex-col gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">供应商名称</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="OpenAI"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Base URL</label>
              <input
                type="url"
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="https://api.openai.com"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">API Key</label>
              <div className="flex gap-1">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="sk-..."
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="px-2 py-2 border rounded-lg hover:bg-gray-50 text-xs"
                >
                  {showApiKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">模型名称</label>
              <input
                type="text"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="gpt-3.5-turbo"
                required
              />
            </div>

            <div className="mt-auto pt-4">
              <button
                type="submit"
                disabled={saving}
                className="w-full px-4 py-2.5 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {saving ? '保存中...' : '保存并测试'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
