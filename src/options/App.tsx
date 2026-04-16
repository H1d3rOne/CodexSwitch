import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'
import { ProviderCard } from '../components/ProviderCard'
import { ProviderForm } from '../components/ProviderForm'
import { downloadJSON, readJSONFile, validateExportData } from '../utils/export'
import type { ExportData } from '../types'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadProviders()
  }, [])

  async function loadProviders() {
    const response = await sendMessage<{ success: boolean; data: Provider[] }>('GET_PROVIDERS')
    if (response.success) {
      setProviders(response.data)
    }
  }

  async function handleSave(data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) {
    setLoading(true)

    if (editingProvider) {
      await sendMessage('UPDATE_PROVIDER', {
        id: editingProvider.id,
        updates: data,
      })
      await sendMessage('TEST_PROVIDER', { ...editingProvider, ...data })
    } else {
      const response = await sendMessage<{ success: boolean; data: Provider }>(
        'ADD_PROVIDER',
        data
      )
      if (response.success) {
        await sendMessage('TEST_PROVIDER', response.data)
      }
    }

    setShowForm(false)
    setEditingProvider(null)
    await loadProviders()
    setLoading(false)
  }

  async function handleTest(id: string) {
    const provider = providers.find(p => p.id === id)
    if (provider) {
      await sendMessage('TEST_PROVIDER', provider)
      await loadProviders()
    }
  }

  async function handleEdit(id: string) {
    const provider = providers.find(p => p.id === id)
    if (provider) {
      setEditingProvider(provider)
      setShowForm(true)
    }
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
      downloadJSON(
        response.data,
        `codex-switch-${new Date().toISOString().split('T')[0]}.json`
      )
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
        alert('导入成功')
        await loadProviders()
      } else {
        alert(`导入失败：${response.error}`)
      }
    } catch (error) {
      alert(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
    }

    event.target.value = ''
  }

  function handleCancel() {
    setShowForm(false)
    setEditingProvider(null)
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">供应商管理</h1>

      <div className="mb-6 flex gap-3">
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          + 添加供应商
        </button>
        <label className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 cursor-pointer">
          导入
          <input
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </label>
        <button
          onClick={handleExport}
          disabled={providers.length === 0}
          className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
        >
          导出
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold mb-4">
              {editingProvider ? '编辑供应商' : '添加供应商'}
            </h2>
            <ProviderForm
              provider={editingProvider || undefined}
              onSave={handleSave}
              onCancel={handleCancel}
            />
          </div>
        </div>
      )}

      <div>
        {providers.length === 0 ? (
          <div className="text-center text-gray-500 py-12">
            暂无供应商，点击"添加供应商"开始
          </div>
        ) : (
          providers.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onTest={handleTest}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
