import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'
import { StatusBadge } from '../components/StatusBadge'

function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload })
}

export function App() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [testing, setTesting] = useState(false)

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
    setTesting(true)
    const provider = providers.find(p => p.id === id)
    if (provider) {
      await sendMessage('TEST_PROVIDER', provider)
      await loadProviders()
    }
    setTesting(false)
  }

  function handleOpenOptions() {
    chrome.runtime.openOptionsPage()
  }

  return (
    <div className="p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-600 mb-1">当前供应商</h2>
        {activeProvider ? (
          <div className="bg-blue-50 rounded p-3">
            <div className="font-semibold">{activeProvider.name}</div>
            <div className="text-sm text-gray-600">{activeProvider.baseUrl}</div>
            <div className="mt-1">
              <StatusBadge status={activeProvider.testStatus} />
            </div>
          </div>
        ) : (
          <div className="text-gray-500 text-sm">未选择供应商</div>
        )}
      </div>

      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-600 mb-2">供应商列表</h2>
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {providers.length === 0 ? (
            <div className="text-gray-400 text-sm text-center py-4">暂无供应商</div>
          ) : (
            providers.map(provider => (
              <div
                key={provider.id}
                className="flex items-center justify-between p-2 border rounded hover:bg-gray-50"
              >
                <label className="flex items-center flex-1 cursor-pointer">
                  <input
                    type="radio"
                    name="activeProvider"
                    checked={provider.isActive}
                    onChange={() => handleSetActive(provider.id)}
                    className="mr-2"
                  />
                  <div className="flex-1">
                    <div className="font-medium text-sm">{provider.name}</div>
                    <div className="text-xs text-gray-500">{provider.baseUrl}</div>
                  </div>
                </label>
                <button
                  onClick={() => handleTestProvider(provider.id)}
                  disabled={testing}
                  className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                >
                  测试
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => activeProvider && handleTestProvider(activeProvider.id)}
          disabled={!activeProvider || testing}
          className="flex-1 px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
        >
          {testing ? '测试中...' : '快速测试'}
        </button>
        <button
          onClick={handleOpenOptions}
          className="flex-1 px-3 py-2 bg-gray-500 text-white rounded hover:bg-gray-600"
        >
          管理供应商
        </button>
      </div>
    </div>
  )
}
