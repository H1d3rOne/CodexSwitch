import React, { useState, useEffect } from 'react'
import type { Provider } from '../types'

interface ProviderFormProps {
  provider?: Provider
  onSave: (data: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
}

export function ProviderForm({ provider, onSave, onCancel }: ProviderFormProps) {
  const [name, setName] = useState(provider?.name || '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '')
  const [apiKey, setApiKey] = useState(provider?.apiKey || '')
  const [model, setModel] = useState(provider?.model || 'gpt-3.5-turbo')
  const [models, setModels] = useState<string[]>(provider?.models || [])
  const [newModel, setNewModel] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (provider) {
      setName(provider.name)
      setBaseUrl(provider.baseUrl)
      setApiKey(provider.apiKey)
      setModel(provider.model)
      setModels(provider.models || [])
    }
  }, [provider])

  const addModel = () => {
    if (newModel.trim() && !models.includes(newModel.trim())) {
      setModels([...models, newModel.trim()])
      setNewModel('')
    }
  }

  const removeModel = (m: string) => {
    setModels(models.filter(x => x !== m))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      name,
      baseUrl,
      apiKey,
      model,
      models: models.length > 0 ? models : [model],
      isActive: provider?.isActive || false,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          供应商名称
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Base URL
        </label>
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://api.openai.com"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          API Key
        </label>
        <div className="flex gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="px-3 py-2 border rounded hover:bg-gray-100"
          >
            👁
          </button>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          模型名称
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="gpt-3.5-turbo"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          可用模型列表
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addModel())}
            className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="添加模型名称"
          />
          <button
            type="button"
            onClick={addModel}
            className="px-3 py-2 bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
          >
            添加
          </button>
        </div>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {models.map(m => (
              <div key={m} className="flex items-center gap-1 px-2 py-1 bg-slate-100 rounded text-sm">
                <span className="font-mono text-slate-700">{m}</span>
                <button
                  type="button"
                  onClick={() => removeModel(m)}
                  className="w-4 h-4 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border rounded hover:bg-gray-100"
        >
          取消
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          保存并测试
        </button>
      </div>
    </form>
  )
}
