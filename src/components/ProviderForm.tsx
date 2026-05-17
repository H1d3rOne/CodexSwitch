import React, { useState, useEffect } from 'react'
import type { Provider, ApiType, ModelEntry, ProviderFormat } from '../types'

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
  const [models, setModels] = useState<ModelEntry[]>(provider?.models || [])
  const [newModel, setNewModel] = useState('')
  const [newModelApiType, setNewModelApiType] = useState<ApiType>('both')
  const [apiType, setApiType] = useState<ApiType>(provider?.apiType || 'both')
  const [format, setFormat] = useState<ProviderFormat>(provider?.format || 'openai')
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    if (provider) {
      setName(provider.name)
      setBaseUrl(provider.baseUrl)
      setApiKey(provider.apiKey)
      setModel(provider.model)
      setModels(provider.models || [])
      setApiType(provider.apiType || 'both')
      setFormat(provider.format || 'openai')
    }
  }, [provider])

  const addModel = () => {
    const m = newModel.trim()
    if (m && !models.some(x => x.name === m)) {
      setModels([...models, { name: m, apiType: newModelApiType }])
      setNewModel('')
      setNewModelApiType('both')
    }
  }

  const removeModel = (m: string) => {
    setModels(models.filter(x => x.name !== m))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      name,
      baseUrl,
      apiKey,
      model,
      models: models.length > 0 ? models : (model ? [{ name: model, apiType }] : []),
      apiType,
      format,
      groupApiKeys: provider?.groupApiKeys || {},
      groupModels: provider?.groupModels || {},
      activeGroup: provider?.activeGroup || 'default',
      isActive: provider?.isActive || false,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">供应商名称</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500" required />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Base URL</label>
        <input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} required />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">API Key</label>
        <div className="relative">
          <input type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value)}
            className="w-full px-3 py-2 pr-8 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500" required />
          <button type="button" onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              {showApiKey ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              )}
            </svg>
          </button>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">API Format</label>
        <div className="flex gap-2">
          <button type="button" onClick={() => setFormat('openai')}
            className={`flex-1 px-3 py-2 text-sm rounded border transition-colors ${
              format === 'openai' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            OpenAI
          </button>
          <button type="button" onClick={() => setFormat('anthropic')}
            className={`flex-1 px-3 py-2 text-sm rounded border transition-colors ${
              format === 'anthropic' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}>
            Anthropic
          </button>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">模型名称</label>
        <input type="text" value={model} onChange={e => setModel(e.target.value)}
          className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={format === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-3.5-turbo'} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">可用模型列表</label>
        <div className="flex gap-2 mb-2">
          <input type="text" value={newModel} onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addModel())}
            className="flex-1 px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="添加模型名称" />
          <select value={newModelApiType} onChange={e => setNewModelApiType(e.target.value as ApiType)}
            className="px-2 py-2 text-xs bg-white border rounded focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="chat">Chat</option>
            <option value="responses">Responses</option>
            <option value="both">Both</option>
          </select>
          <button type="button" onClick={addModel}
            className="px-3 py-2 bg-slate-100 text-slate-600 rounded hover:bg-slate-200">添加</button>
        </div>
        {models.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {models.map(m => (
              <div key={m.name} className="flex items-center gap-1 px-2 py-1 bg-slate-100 rounded text-sm">
                <span className={`px-1 py-px text-[7px] font-bold uppercase tracking-wider rounded ${
                  m.apiType === 'both' ? 'bg-purple-50 text-purple-500'
                    : m.apiType === 'responses' ? 'bg-blue-50 text-blue-500'
                    : 'bg-amber-50 text-amber-500'
                }`}>{m.apiType}</span>
                <span className="font-mono text-slate-700">{m.name}</span>
                <button type="button" onClick={() => removeModel(m.name)}
                  className="w-4 h-4 flex items-center justify-center rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="px-4 py-2 border rounded hover:bg-gray-100">取消</button>
        <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">保存并测试</button>
      </div>
    </form>
  )
}
