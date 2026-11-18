import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { App } from '../src/popup/App'
import type { Provider, ProviderFormat } from '../src/types'

const sendMessageMock = vi.fn()
let storedProviders: Provider[]
let routerStatus: any

function makeProvider(id: string, name: string, overrides: Partial<Provider> = {}): Provider {
  const format = overrides.format || 'openai'
  const model = format === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'
  return {
    id, name, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test',
    groupApiKeys: { default: 'sk-test' }, groupModels: {}, activeGroup: 'default',
    model, models: [{ name: model, apiType: 'chat', format }], apiType: 'chat', format,
    isActive: false, createdAt: 1, updatedAt: 1, ...overrides,
  }
}

describe('debug', () => {
  it('shows effective selection', async () => {
    routerStatus = { enabled: true, running: true, port: 15721, clients: { openai: true, anthropic: true } }
    storedProviders = [
      makeProvider('o', 'Native OpenAI', { isActive: true, formatConversionEnabled: true, routerEffectiveFormats: ['openai'] }),
      makeProvider('a', 'Native Anthropic', { format: 'anthropic', isActive: true, formatConversionEnabled: true, routerEffectiveFormats: ['anthropic'] }),
    ]
    sendMessageMock.mockImplementation(async (message: any) => {
      if (message.type === 'GET_PROVIDERS') return { success: true, data: storedProviders }
      if (message.type === 'GET_SITES') return { success: true, data: [] }
      if (message.type === 'GET_ROUTER_STATUS') { console.log('MOCK_STATUS', JSON.stringify(routerStatus)); return { success: true, data: { ...routerStatus } } }
      if (message.type === 'GET_CHAT_SESSIONS') return { success: true, data: { sessions: [], activeId: null } }
      return { success: true }
    })
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: sendMessageMock, connect: vi.fn(() => ({ postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } })), lastError: undefined },
      storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) } },
    })
    vi.stubGlobal('alert', vi.fn())
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    render(<App />)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'OpenAI' })).toBeVisible())
    await waitFor(() => expect(sendMessageMock.mock.calls.filter(c => c[0].type === 'GET_ROUTER_STATUS')).toHaveLength(1))
    await new Promise(r => setTimeout(r, 50))
    const panel = screen.getByRole('tabpanel', { name: 'OpenAI' })
    const btn = within(panel).getByRole('button', { name: 'Activate Native OpenAI' })

    await new Promise(r => setTimeout(r, 100))
    console.log('PRESSED2', btn.getAttribute('aria-pressed'), 'CLIENTS_STATE', JSON.stringify(sendMessageMock.mock.calls.filter(c=>c[0].type==='GET_ROUTER_STATUS').length))
    console.log('CLIENTS', JSON.stringify(screen.queryAllByRole('switch').map(s => s.getAttribute('aria-checked'))), JSON.stringify(sendMessageMock.mock.calls.map(c => c[0].type)))
    console.log('SWITCHES', screen.queryAllByRole('switch').map(el => `${el.getAttribute('aria-label')}=${el.getAttribute('aria-checked')}`).join(' | '))
    console.log('ARTICLE_CLASS', within(panel).getByRole('article', { name: 'Native OpenAI' }).className)
    console.log('PROVIDERS', JSON.stringify(storedProviders.map(p => ({ id: p.id, ref: p.routerEffectiveFormats }))))
  })
})
