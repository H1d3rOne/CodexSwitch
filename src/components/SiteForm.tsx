import React, { useState } from 'react'
import type { Site } from '../types'

interface SiteFormProps {
  onSave: (data: Omit<Site, 'id' | 'createdAt' | 'updatedAt'>) => void
  onCancel: () => void
}

export function SiteForm({ onSave, onCancel }: SiteFormProps) {
  const [mode, setMode] = useState<'auto' | 'manual'>('manual')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [checkinUrl, setCheckinUrl] = useState('')
  const [checkinMethod, setCheckinMethod] = useState<'GET' | 'POST'>('POST')
  const [showCheckinConfig, setShowCheckinConfig] = useState(false)
  const [showToken, setShowToken] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return

    onSave({
      name: name.trim(),
      url: url.trim(),
      token: token.trim() || undefined,
      checkinUrl: checkinUrl.trim() || undefined,
      checkinMethod: showCheckinConfig ? checkinMethod : undefined,
    })
  }

  async function handleAutoDetect() {
    if (!url.trim()) return
    try {
      const urlObj = new URL(url.trim())
      setName(urlObj.hostname.replace(/^www\./, ''))

      chrome.cookies?.getAll({ domain: urlObj.hostname }, (cookies) => {
        if (chrome.runtime.lastError || !cookies.length) return
        const authCookie = cookies.find(c =>
          c.name.toLowerCase().includes('token') ||
          c.name.toLowerCase().includes('session') ||
          c.name.toLowerCase().includes('auth') ||
          c.name.includes('_t') ||
          c.name === 'token'
        )
        if (authCookie) {
          setToken(authCookie.value)
        }
      })
    } catch {}
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
        <button type="button" onClick={() => setMode('auto')}
          className={`flex-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
            mode === 'auto' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'
          }`}>
          Auto Detect
        </button>
        <button type="button" onClick={() => setMode('manual')}
          className={`flex-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
            mode === 'manual' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'
          }`}>
          Manual Add
        </button>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Site URL</label>
        <input type="url" value={url} onChange={e => setUrl(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
          placeholder="https://example.com" required />
        {mode === 'auto' && url && (
          <button type="button" onClick={handleAutoDetect}
            className="mt-1.5 w-full px-2.5 py-1.5 text-[10px] font-medium text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
            Detect from Browser
          </button>
        )}
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Site Name</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          className="w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400"
          placeholder="My Site" required />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-slate-600 mb-1">Token</label>
        <div className="relative">
          <input type={showToken ? 'text' : 'password'} value={token} onChange={e => setToken(e.target.value)}
            className="w-full px-2.5 py-1.5 pr-7 text-[11px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 font-mono"
            placeholder="Optional - auto-detected in auto mode" />
          <button type="button" onClick={() => setShowToken(!showToken)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              {showToken ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              )}
            </svg>
          </button>
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setShowCheckinConfig(!showCheckinConfig)}
          className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 transition-colors">
          <svg className={`w-3 h-3 transition-transform ${showCheckinConfig ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          Check-in Config (optional)
        </button>

        {showCheckinConfig && (
          <div className="mt-2 space-y-2 pl-2 border-l-2 border-blue-200">
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Check-in URL</label>
              <input type="url" value={checkinUrl} onChange={e => setCheckinUrl(e.target.value)}
                className="w-full px-2 py-1 text-[10px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400"
                placeholder="/api/checkin" />
            </div>
            <div>
              <label className="block text-[10px] text-slate-500 mb-0.5">Method</label>
              <select value={checkinMethod} onChange={e => setCheckinMethod(e.target.value as 'GET' | 'POST')}
                className="px-2 py-1 text-[10px] bg-white border border-slate-200 rounded focus:outline-none focus:border-blue-400">
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="flex-1 px-3 py-1.5 text-[11px] font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          Cancel
        </button>
        <button type="submit"
          className="flex-1 px-3 py-1.5 text-[11px] font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors">
          Add Site
        </button>
      </div>
    </form>
  )
}
