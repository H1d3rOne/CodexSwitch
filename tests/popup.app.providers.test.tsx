import React from 'react'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { App } from '../src/popup/App'
import type { ApiType, Provider, ProviderFormat } from '../src/types'

const sendMessageMock = vi.fn()
const writeTextMock = vi.fn()
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
let storedProviders: Provider[]
let routerStatus: { enabled: boolean; running: boolean; port: number; clients?: Partial<Record<ProviderFormat, boolean>> }

function makeProvider(id: string, name: string, overrides: Partial<Provider> = {}): Provider {
  const format = overrides.format || 'openai'
  const model = format === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'
  return {
    id,
    name,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    groupApiKeys: { default: 'sk-test' },
    groupModels: {},
    activeGroup: 'default',
    model,
    models: [{ name: model, apiType: 'chat', format }],
    apiType: 'chat',
    format,
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function getMessages(type: string) {
  return sendMessageMock.mock.calls
    .map(([message]) => message)
    .filter(message => message.type === type)
}

function getCardNames(panel: HTMLElement) {
  return within(panel).queryAllByRole('article').map(card => card.getAttribute('aria-label'))
}

function getProviderTab(format: ProviderFormat) {
  return screen.getByRole('tab', { name: format === 'anthropic' ? 'Anthropic' : format === 'deepseek' ? 'DeepSeek' : 'OpenAI' })
}

function switchProviderTab(format: ProviderFormat) {
  fireEvent.click(getProviderTab(format))
  return screen.getByRole('tabpanel', { name: format === 'anthropic' ? 'Anthropic' : format === 'deepseek' ? 'DeepSeek' : 'OpenAI' })
}

async function renderProviders() {
  render(<App />)
  // Wait for GET_ROUTER_STATUS so per-client routing state (使用路由) is loaded.
  await waitFor(() => expect(getMessages('GET_ROUTER_STATUS')).toHaveLength(1))
  await waitFor(() => expect(getProviderTab('openai')).toBeVisible())
  return screen.getByRole('tabpanel', { name: 'OpenAI' })
}

describe('App provider cards', () => {
  describe('client identity live settings', () => {
    async function openIdentitySettings() {
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: '路由设置', exact: true }))
      return screen.getByRole('region', { name: '浏览器伪装成客户端' })
    }

    it('queues the latest edits while a save is pending without disabling controls or overwriting drafts', async () => {
      const original = sendMessageMock.getMockImplementation()!
      let release!: (result: unknown) => void
      sendMessageMock.mockImplementation(message => {
        if (message.type === 'SET_CLIENT_IDENTITY' && getMessages('SET_CLIENT_IDENTITY').length === 1) {
          return new Promise(resolve => { release = resolve })
        }
        if (message.type === 'SET_CLIENT_IDENTITY') return Promise.resolve({ success: true, data: message.payload })
        return original(message)
      })
      const section = await openIdentitySettings()
      const preset = within(section).getByRole('combobox', { name: '浏览器伪装预设（默认）' })
      fireEvent.change(preset, { target: { value: 'codex' } })
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY')).toHaveLength(1))
      expect(preset).toBeEnabled()
      fireEvent.change(preset, { target: { value: 'opencode' } })
      const version = within(section).getByRole('textbox', { name: '客户端版本号' })
      fireEvent.change(version, { target: { value: '9.8.7' } })
      fireEvent.blur(version)
      await act(async () => release({ success: true, data: getMessages('SET_CLIENT_IDENTITY')[0].payload }))
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload.default).toEqual({ preset: 'opencode', version: '9.8.7' }))
      expect(preset).toHaveValue('opencode')
      expect(version).toHaveValue('9.8.7')
      await waitFor(() => expect(within(section).getByText('已应用浏览器伪装')).toBeVisible())
    })

    it('autosaves text edits and allows another change after an application error', async () => {
      const original = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(message => {
        if (message.type === 'SET_CLIENT_IDENTITY') return getMessages('SET_CLIENT_IDENTITY').length === 1
          ? Promise.reject(new Error('Native connection failed'))
          : Promise.resolve({ success: true, data: message.payload })
        return original(message)
      })
      const section = await openIdentitySettings()
      const preset = within(section).getByRole('combobox')
      fireEvent.change(preset, { target: { value: 'custom' } })
      await waitFor(() => expect(within(section).getByText('Native connection failed')).toBeVisible())
      const ua = within(section).getByRole('textbox', { name: '自定义 User-Agent' })
      fireEvent.change(ua, { target: { value: 'custom/first' } })
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload.default.userAgent).toBe('custom/first'))
      fireEvent.change(ua, { target: { value: 'custom/second' } })
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload.default.userAgent).toBe('custom/second'))
    })

    it('does not let a late settings load revert a newer edit', async () => {
      const original = sendMessageMock.getMockImplementation()!
      let release!: (result: unknown) => void
      sendMessageMock.mockImplementation(message => {
        if (message.type === 'GET_CLIENT_IDENTITY') return new Promise(resolve => { release = resolve })
        if (message.type === 'SET_CLIENT_IDENTITY') return Promise.resolve({ success: true, data: message.payload })
        return original(message)
      })
      const section = await openIdentitySettings()
      const preset = within(section).getByRole('combobox')
      fireEvent.change(preset, { target: { value: 'off' } })
      await waitFor(() => expect(within(section).getByText('已关闭浏览器伪装')).toBeVisible())
      await act(async () => release({ success: true, data: { default: { preset: 'auto' }, formatIdentities: {} } }))
      expect(preset).toHaveValue('off')
    })

    it('preserves incomplete custom header text until a value is entered and autosaves later changes', async () => {
      const original = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(message => message.type === 'SET_CLIENT_IDENTITY'
        ? Promise.resolve({ success: true, data: message.payload })
        : original(message))
      const section = await openIdentitySettings()
      fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'custom' } })
      const headers = within(section).getByRole('textbox', { name: '自定义请求头（每行一个 Header: Value）' })
      for (const text of ['x', 'x-team', 'x-team:', 'x-team: lab\n']) {
        fireEvent.change(headers, { target: { value: text } })
        expect(headers).toHaveValue(text)
      }
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload.default.extraHeaders).toEqual({ 'x-team': 'lab' }))
      expect(headers).toHaveValue('x-team: lab\n')
      fireEvent.change(headers, { target: { value: 'x-team: second' } })
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload.default.extraHeaders).toEqual({ 'x-team': 'second' }))
    })

    it('keeps per-format edits independent while saving across tabs', async () => {
      const original = sendMessageMock.getMockImplementation()!
      let release!: (result: unknown) => void
      sendMessageMock.mockImplementation(message => {
        if (message.type === 'SET_CLIENT_IDENTITY') return getMessages('SET_CLIENT_IDENTITY').length === 1
          ? new Promise(resolve => { release = resolve })
          : Promise.resolve({ success: true, data: message.payload })
        return original(message)
      })
      const section = await openIdentitySettings()
      fireEvent.click(within(section).getByRole('tab', { name: 'OpenAI' }))
      fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'codex' } })
      fireEvent.click(within(section).getByRole('tab', { name: 'Anthropic' }))
      fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'off' } })
      fireEvent.click(within(section).getByRole('tab', { name: 'DeepSeek' }))
      fireEvent.change(within(section).getByRole('combobox'), { target: { value: 'opencode' } })
      await act(async () => release({ success: true, data: getMessages('SET_CLIENT_IDENTITY')[0].payload }))
      await waitFor(() => expect(getMessages('SET_CLIENT_IDENTITY').at(-1)?.payload).toEqual({
        default: { preset: 'auto' },
        formatIdentities: { openai: { preset: 'codex' }, anthropic: { preset: 'off' }, deepseek: { preset: 'opencode' } },
      }))
      expect(within(section).getByRole('combobox')).toHaveValue('opencode')
    })
  })

  it.each(['paste', 'blur'])('decodes a Base64 API key on %s and saves the active group', async event => {
    await renderProviders()
    fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
    const input = screen.getByDisplayValue('sk-test') as HTMLInputElement
    const key = 'sk-decoded-secret'
    if (event === 'paste') {
      input.setSelectionRange(0, input.value.length)
      fireEvent.paste(input, { clipboardData: { getData: () => btoa(key) } })
    } else {
      fireEvent.change(input, { target: { value: btoa(key) } })
      fireEvent.blur(input)
    }
    expect(input.value).toBe(key)
    fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
    await waitFor(() => expect(getMessages('UPDATE_PROVIDER').at(-1)?.payload.updates).toMatchObject({
      apiKey: key, groupApiKeys: { default: key },
    }))
  })

  beforeEach(() => {
    routerStatus = { enabled: false, running: false, port: 15721 }
    storedProviders = [
      makeProvider('openai', 'OpenAI Provider'),
      makeProvider('anthropic', 'Anthropic Provider', { format: 'anthropic' }),
    ]
    sendMessageMock.mockReset()
    writeTextMock.mockReset()
    writeTextMock.mockResolvedValue(undefined)
    sendMessageMock.mockImplementation(async (message: { type: string; payload?: any }) => {
      if (message.type === 'GET_PROVIDERS') return { success: true, data: storedProviders }
      if (message.type === 'GET_SITES') return { success: true, data: [] }
      if (message.type === 'GET_ROUTER_STATUS') return { success: true, data: { ...routerStatus } }
      if (message.type === 'SET_CLIENT_ROUTING') {
        routerStatus = { ...routerStatus, clients: { ...routerStatus.clients, [message.payload.format]: message.payload.enabled } }
        return { success: true, data: { ...routerStatus } }
      }
      if (message.type === 'ENABLE_ROUTER' || message.type === 'DISABLE_ROUTER') {
        const enabled = message.type === 'ENABLE_ROUTER'
        routerStatus = { enabled, running: enabled, port: message.payload?.port || routerStatus.port }
        return { success: true, data: { ...routerStatus } }
      }
      if (message.type === 'GET_CHAT_SESSIONS') {
        return { success: true, data: { sessions: [], activeId: null } }
      }
      if (message.type === 'SET_ACTIVE_PROVIDER') {
        storedProviders = storedProviders.map(provider => ({
          ...provider,
          ...(message.payload.targetFormat ? { routerActiveFormats: [
            ...(provider.routerActiveFormats || []).filter(format => format !== message.payload.targetFormat),
            ...(provider.id === message.payload.id ? [message.payload.targetFormat] : []),
          ] } : { isActive: provider.id === message.payload.id }),
        }))
      }
      if (message.type === 'UPDATE_PROVIDER') {
        storedProviders = storedProviders.map(provider => provider.id === message.payload.id
          ? { ...provider, ...message.payload.updates }
          : provider)
      }
      if (message.type === 'DELETE_PROVIDER') {
        storedProviders = storedProviders.filter(provider => provider.id !== message.payload)
      }
      if (message.type === 'ADD_PROVIDER') {
        const copiedProvider = makeProvider('copied', message.payload.name, message.payload)
        storedProviders = [...storedProviders, copiedProvider]
        return { success: true, data: copiedProvider }
      }
      return { success: true }
    })

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: sendMessageMock,
        connect: vi.fn(() => ({
          postMessage: vi.fn(),
          disconnect: vi.fn(),
          onMessage: { addListener: vi.fn() },
          onDisconnect: { addListener: vi.fn() },
        })),
        lastError: undefined,
      },
      storage: {
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      },
    })
    vi.stubGlobal('alert', vi.fn())
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('filters by format, keeping chat, responses, both and legacy providers in OpenAI', async () => {
    storedProviders = [
      makeProvider('anthropic-first', 'Anthropic First', { format: 'anthropic' }),
      makeProvider('responses', 'Responses Provider', {
        apiType: 'responses',
        models: [{ name: 'gpt-4.1', apiType: 'responses', format: 'openai' }],
      }),
      makeProvider('anthropic-second', 'Anthropic Second', { format: 'anthropic', apiType: 'both' }),
      makeProvider('chat', 'Chat Provider'),
      makeProvider('both', 'Both Provider', {
        apiType: 'both',
        models: [{ name: 'gpt-4.1', apiType: 'both', format: 'openai' }],
      }),
      makeProvider('legacy', 'Legacy Provider', { format: undefined }),
    ]
    const openaiPanel = await renderProviders()

    expect(getCardNames(openaiPanel)).toEqual([
      'Responses Provider', 'Chat Provider', 'Both Provider', 'Legacy Provider',
    ])
    expect(within(getProviderTab('openai')).getByText('4')).toBeVisible()
    expect(within(getProviderTab('anthropic')).getByText('2')).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Anthropic First' })).not.toBeInTheDocument()

    const anthropicPanel = switchProviderTab('anthropic')
    expect(getCardNames(anthropicPanel)).toEqual(['Anthropic First', 'Anthropic Second'])
    expect(screen.queryByRole('article', { name: 'Responses Provider' })).not.toBeInTheDocument()
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('places three sticky horizontal tabs at the top of Providers with linked panels', async () => {
    await renderProviders()
    const tabs = screen.getByRole('tablist', { name: 'Provider formats' })

    expect(tabs).toHaveAttribute('aria-orientation', 'horizontal')
    expect(tabs).toHaveClass('flex', 'sticky', 'top-0')
    expect(tabs).not.toHaveClass('flex-col')
    expect(tabs.parentElement!.firstElementChild).toBe(tabs)
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3)
    expect(getProviderTab('openai')).toHaveAttribute('aria-selected', 'true')
    expect(getProviderTab('anthropic')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    for (const format of ['openai', 'anthropic', 'deepseek'] as const) {
      const panel = document.getElementById(`provider-panel-${format}`)!
      expect(getProviderTab(format)).toHaveAttribute('aria-controls', panel.id)
      expect(panel).toHaveAttribute('aria-labelledby', `provider-tab-${format}`)
      expect(panel.hidden).toBe(format !== 'openai')
    }
    expect(screen.queryByRole('heading', { name: 'OpenAI' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Anthropic' })).not.toBeInTheDocument()
  })

  it('supports horizontal keyboard navigation with focused and selected tabs', async () => {
    await renderProviders()
    getProviderTab('openai').focus()

    for (const [key, format] of [
      ['ArrowRight', 'anthropic'],
      ['ArrowRight', 'deepseek'],
      ['ArrowRight', 'openai'],
      ['ArrowLeft', 'deepseek'],
      ['Home', 'openai'],
      ['End', 'deepseek'],
    ] as const) {
      fireEvent.keyDown(document.activeElement!, { key })
      expect(getProviderTab(format)).toHaveFocus()
      expect(getProviderTab(format)).toHaveAttribute('aria-selected', 'true')
      expect(getProviderTab(format)).toHaveAttribute('tabindex', '0')
      expect(getProviderTab(format === 'openai' ? 'anthropic' : 'openai')).toHaveAttribute('tabindex', '-1')
      expect(getCardNames(screen.getByRole('tabpanel'))).toEqual(format === 'deepseek' ? [] : [
        format === 'anthropic' ? 'Anthropic Provider' : 'OpenAI Provider',
      ])
    }
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it.each<ProviderFormat>(['openai', 'anthropic'])('preserves the original compact card styles for %s', async format => {
    await renderProviders()
    const panel = switchProviderTab(format)
    const card = within(panel).getByRole('article')

    expect(card.parentElement).toHaveClass('p-2', 'space-y-1.5')
    expect(card.parentElement).not.toHaveClass('grid')
    expect(card).toHaveClass('group', 'rounded-lg', 'ring-2', 'ring-slate-200', 'bg-white')
    expect(card).not.toHaveClass('rounded-xl', 'p-3')
    expect(card.firstElementChild).toHaveClass('flex', 'items-start', 'gap-2', 'px-2.5', 'py-1.5')
    expect(within(card).getByRole('button', { name: /Activate/ })).toHaveClass('text-[11px]', 'font-semibold')
    expect(within(card).getByText('https://api.example.com/v1')).toHaveClass('text-[9px]', 'font-mono')
    for (const action of ['Test', 'Duplicate', 'Share', 'Edit', 'Delete']) {
      expect(within(card).getByRole('button', { name: `${action} ${card.getAttribute('aria-label')}` })).toHaveClass('w-5', 'h-5')
    }
  })

  it.each<ProviderFormat>(['openai', 'anthropic'])('shows an empty tab when only %s providers exist', async format => {
    storedProviders = [makeProvider('only', 'Only Provider', { format })]
    await renderProviders()
    expect(getCardNames(switchProviderTab(format))).toEqual(['Only Provider'])
    const emptyFormat = format === 'openai' ? 'anthropic' : 'openai'
    const emptyPanel = switchProviderTab(emptyFormat)
    const emptyTitle = format === 'openai' ? 'Anthropic' : 'OpenAI'

    expect(within(emptyPanel).getByText(`No ${emptyTitle} providers yet`)).toBeVisible()
    expect(within(getProviderTab(emptyFormat)).getByText('0')).toBeVisible()
    expect(getCardNames(emptyPanel)).toEqual([])
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled()
  })

  it('keeps the original empty state when there are no providers', async () => {
    storedProviders = []
    await renderProviders()

    expect(screen.getByText('Click + to add a provider')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(getCardNames(switchProviderTab('anthropic'))).toEqual([])
    expect(screen.getByText('Click + to add a provider')).toBeVisible()
  })

  it('preserves the original active state, balance, URL and model', async () => {
    storedProviders = [makeProvider('active', 'Active Provider', {
      isActive: true,
      balance: '$12.34',
      models: [{ name: 'gpt-4.1', apiType: 'responses', format: 'openai' }],
    })]
    await renderProviders()
    const cardElement = screen.getByRole('article', { name: 'Active Provider' })
    const card = within(cardElement)

    expect(cardElement).toHaveClass('ring-emerald-400', 'bg-emerald-50/50', 'shadow-sm')
    expect(card.getByText('$12.34')).toBeVisible()
    expect(card.getByText('https://api.example.com/v1')).toBeVisible()
    expect(card.getByText('gpt-4.1')).toBeVisible()
    expect(card.getByText('openai')).toBeVisible()
    expect(card.queryByText('Active')).not.toBeInTheDocument()
    expect(card.queryByText('responses')).not.toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Activate Active Provider' })).toHaveAttribute('aria-pressed', 'true')
    expect(card.getByRole('button', { name: 'Choose model for Active Provider' })).toBeEnabled()
    fireEvent.click(card.getByRole('button', { name: 'Choose model for Active Provider' }))
    expect(card.getByRole('button', { name: 'Choose model for Active Provider' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('activates a provider when clicking the card', async () => {
    await renderProviders()
    switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('article', { name: 'Anthropic Provider' }))

    await waitFor(() => {
      expect(getMessages('SET_ACTIVE_PROVIDER')).toEqual([
        { type: 'SET_ACTIVE_PROVIDER', payload: { id: 'anthropic', sync: true } },
      ])
      expect(screen.getByRole('button', { name: 'Activate Anthropic Provider' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('provides an accessible activation button without activating twice through bubbling', async () => {
    await renderProviders()
    fireEvent.click(screen.getByRole('button', { name: 'Activate OpenAI Provider' }))

    await waitFor(() => {
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Activate OpenAI Provider' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it.each<ProviderFormat>(['openai', 'anthropic'])('keeps model switching working for %s cards', async format => {
    const firstModel = format === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'
    const secondModel = format === 'anthropic' ? 'claude-opus-4-1' : 'gpt-4.1-mini'
    storedProviders = [makeProvider('multiple', 'Multiple Models', {
      format,
      models: [
        { name: firstModel, apiType: 'chat', format },
        { name: secondModel, apiType: 'responses', format },
      ],
    })]
    await renderProviders()
    switchProviderTab(format)
    const card = screen.getByRole('article', { name: 'Multiple Models' })
    fireEvent.click(within(card).getByRole('button', { name: 'Choose model for Multiple Models' }))
    expect(within(card).getByRole('button', { name: 'Choose model for Multiple Models' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(card).getByRole('button', { name: `${format === 'anthropic' ? 'messages' : 'responses'} ${secondModel}` }))

    await waitFor(() => {
      expect(getMessages('UPDATE_PROVIDER')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ id: 'multiple', updates: expect.objectContaining({ model: secondModel }) }) }),
      ])
      expect(within(card).getByRole('button', { name: 'Choose model for Multiple Models' })).toHaveAttribute('aria-expanded', 'false')
      expect(within(card).getByText(secondModel)).toBeVisible()
    })
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('tests a card without activating it', async () => {
    await renderProviders()
    switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Test Anthropic Provider' }))

    await waitFor(() => {
      expect(getMessages('TEST_PROVIDER')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ id: 'anthropic', format: 'anthropic' }) }),
      ])
      expect(screen.getByRole('button', { name: 'Test Anthropic Provider' })).toBeEnabled()
    })
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('keeps Test All testing providers across both tabs', async () => {
    await renderProviders()
    fireEvent.click(screen.getByRole('button', { name: 'Test All' }))

    await waitFor(() => {
      expect(getMessages('TEST_PROVIDER').map(message => message.payload.id)).toEqual(['openai', 'anthropic'])
      expect(screen.getByRole('button', { name: 'Test All' })).toBeEnabled()
    })
  })

  it('copies a provider into the same format tab without activating it', async () => {
    await renderProviders()
    const anthropicPanel = switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Anthropic Provider' }))

    await screen.findByRole('article', { name: 'Anthropic Provider (copy)' })
    expect(getMessages('ADD_PROVIDER')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ name: 'Anthropic Provider (copy)', format: 'anthropic', isActive: false }) }),
    ])
    expect(getCardNames(anthropicPanel)).toEqual(['Anthropic Provider', 'Anthropic Provider (copy)'])
    expect(within(getProviderTab('anthropic')).getByText('2')).toBeVisible()
    expect(getCardNames(switchProviderTab('openai'))).toEqual(['OpenAI Provider'])
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('shares the original provider configuration without activating it', async () => {
    await renderProviders()
    switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Share Anthropic Provider' }))

    await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1))
    const exported = JSON.parse(writeTextMock.mock.calls[0][0])
    expect(exported.providers).toHaveLength(1)
    expect(exported.providers[0]).toMatchObject({ name: 'Anthropic Provider', format: 'anthropic', model: 'claude-sonnet-4-5' })
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('opens the existing editor without activating the provider', async () => {
    await renderProviders()
    switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Anthropic Provider' }))

    expect(await screen.findByDisplayValue('Anthropic Provider')).toBeVisible()
    expect(screen.getByDisplayValue('https://api.example.com/v1')).toBeVisible()
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('deletes a provider without activating it and shows its empty tab', async () => {
    await renderProviders()
    const anthropicPanel = switchProviderTab('anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Anthropic Provider' }))

    await waitFor(() => {
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: 'anthropic' }])
      expect(within(anthropicPanel).getByText('No Anthropic providers yet')).toBeVisible()
    })
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('selects cards and checkboxes once and bulk deletes only the current tab', async () => {
    storedProviders.push(makeProvider('openai-second', 'OpenAI Second'))
    const panel = await renderProviders()
    const selectButton = within(panel.parentElement!).getByRole('button', { name: 'Select' })
    const toolbar = selectButton.parentElement!
    fireEvent.click(selectButton)
    const firstCheckbox = within(panel).getByRole('checkbox', { name: 'Select OpenAI Provider' })
    const secondCheckbox = within(panel).getByRole('checkbox', { name: 'Select OpenAI Second' })
    fireEvent.click(firstCheckbox)
    expect(firstCheckbox).toBeChecked()
    expect(within(toolbar).getByRole('button', { name: 'Del (1)' })).toBeVisible()
    fireEvent.click(within(panel).getByRole('article', { name: 'OpenAI Second' }))
    expect(secondCheckbox).toBeChecked()
    expect(within(toolbar).getByRole('button', { name: 'Del (2)' })).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: 'Select OpenAI Provider' }))
    expect(firstCheckbox).not.toBeChecked()
    expect(within(toolbar).getByRole('button', { name: 'Del (1)' })).toBeVisible()
    expect(within(panel).getByRole('article', { name: 'OpenAI Provider' })).toHaveAttribute('draggable', 'false')
    expect(within(panel).queryByRole('button', { name: 'Edit OpenAI Provider' })).not.toBeInTheDocument()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'All' }))
    expect(firstCheckbox).toBeChecked()
    expect(secondCheckbox).toBeChecked()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Deselect' }))
    expect(firstCheckbox).not.toBeChecked()
    expect(secondCheckbox).not.toBeChecked()
    expect(within(toolbar).queryByRole('button', { name: /Del \(/ })).not.toBeInTheDocument()
    fireEvent.click(within(toolbar).getByRole('button', { name: 'All' }))
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Del (2)' }))

    await waitFor(() => {
      expect(getMessages('DELETE_PROVIDER').map(message => message.payload)).toEqual(['openai', 'openai-second'])
      expect(within(panel).getByText('No OpenAI providers yet')).toBeVisible()
    })
    expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic Provider'])
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('clears selected providers when switching tabs without leaving selection mode', async () => {
    const panel = await renderProviders()
    const selectButton = within(panel.parentElement!).getByRole('button', { name: 'Select' })
    const toolbar = selectButton.parentElement!
    fireEvent.click(selectButton)
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select OpenAI Provider' }))
    expect(within(toolbar).getByRole('button', { name: 'Del (1)' })).toBeVisible()

    const anthropicPanel = switchProviderTab('anthropic')
    expect(within(toolbar).queryByRole('button', { name: /Del \(/ })).not.toBeInTheDocument()
    const checkbox = within(anthropicPanel).getByRole('checkbox', { name: 'Select Anthropic Provider' })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Del (1)' }))

    await waitFor(() => {
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: 'anthropic' }])
      expect(within(anthropicPanel).getByText('No Anthropic providers yet')).toBeVisible()
    })
    expect(getCardNames(switchProviderTab('openai'))).toEqual(['OpenAI Provider'])
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Select' }))
    switchProviderTab('anthropic')
    expect(within(toolbar).getByRole('button', { name: 'All' })).toBeDisabled()
    expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
  })

  it('closes the model dropdown when switching tabs', async () => {
    storedProviders[0].models!.push({ name: 'gpt-4.1-mini', apiType: 'responses', format: 'openai' })
    await renderProviders()
    fireEvent.click(screen.getByRole('button', { name: 'Choose model for OpenAI Provider' }))
    expect(screen.getByRole('button', { name: 'responses gpt-4.1-mini' })).toBeVisible()

    switchProviderTab('anthropic')
    expect(screen.queryByRole('button', { name: 'responses gpt-4.1-mini' })).not.toBeInTheDocument()
    switchProviderTab('openai')
    expect(screen.getByRole('button', { name: 'Choose model for OpenAI Provider' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'responses gpt-4.1-mini' })).not.toBeInTheDocument()
  })

  describe('provider format conversion switch', () => {
    it('defaults to off for legacy providers even when the global router is running', async () => {
      routerStatus = { enabled: true, running: true, port: 15721 }
      const openaiPanel = await renderProviders()
      expect(getCardNames(openaiPanel)).toEqual(['OpenAI Provider'])
      expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).not.toBeChecked()
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic Provider'])
      expect(screen.getByRole('switch', { name: 'Format conversion for Anthropic Provider' })).not.toBeChecked()
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { id: 'openai', name: 'OpenAI Provider', nativeTab: 'openai', targetTab: 'anthropic' },
      { id: 'anthropic', name: 'Anthropic Provider', nativeTab: 'anthropic', targetTab: 'openai' },
    ] as const)('toggles conversion entries for $id without copying or activating the provider', async testCase => {
      const original = structuredClone(storedProviders.find(provider => provider.id === testCase.id)!)
      await renderProviders()
      switchProviderTab(testCase.nativeTab)
      fireEvent.click(screen.getByRole('switch', { name: `Format conversion for ${testCase.name}` }))
      await waitFor(() => expect(screen.getByRole('switch', { name: `Format conversion for ${testCase.name}` })).toBeChecked())
      expect(storedProviders.find(provider => provider.id === testCase.id)).toEqual({ ...original, formatConversionEnabled: true })
      expect(getMessages('UPDATE_PROVIDER')).toEqual([
        { type: 'UPDATE_PROVIDER', payload: { id: testCase.id, updates: { formatConversionEnabled: true } } },
      ])

      const targetPanel = switchProviderTab(testCase.targetTab)
      const convertedCard = within(targetPanel).getByRole('article', { name: testCase.name })
      expect(within(convertedCard).getByText('Router')).toBeVisible()
      expect(within(convertedCard).queryByRole('switch')).not.toBeInTheDocument()
      expect(within(convertedCard).getByRole('button', { name: `Activate ${testCase.name}` })).toBeDisabled()
      fireEvent.click(convertedCard)
      switchProviderTab(testCase.nativeTab)
      fireEvent.click(screen.getByRole('switch', { name: `Format conversion for ${testCase.name}` }))
      await waitFor(() => expect(screen.getByRole('switch', { name: `Format conversion for ${testCase.name}` })).not.toBeChecked())
      expect(within(switchProviderTab(testCase.targetTab)).queryByRole('article', { name: testCase.name })).not.toBeInTheDocument()
      expect(storedProviders.find(provider => provider.id === testCase.id)).toEqual({ ...original, formatConversionEnabled: false })
      expect(storedProviders).toHaveLength(2)
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
      expect(getMessages('ENABLE_ROUTER')).toHaveLength(0)
    })

    it('keeps the switch unchanged after an update failure and allows retry', async () => {
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'UPDATE_PROVIDER'
        ? { success: false, error: 'Router unavailable' }
        : originalImplementation(message))
      await renderProviders()
      const conversionSwitch = screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })
      fireEvent.click(conversionSwitch)
      await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not update format conversion: Router unavailable'))
      expect(conversionSwitch).not.toBeChecked()
      expect(conversionSwitch).toBeEnabled()
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic Provider'])
      sendMessageMock.mockImplementation(originalImplementation)
      switchProviderTab('openai')
      fireEvent.click(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' }))
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeChecked())
    })

    it('prevents activation and router changes while updating the conversion switch', async () => {
      let finishUpdate = () => {}
      const updateGate = new Promise<void>(resolve => { finishUpdate = resolve })
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => {
        if (message.type === 'UPDATE_PROVIDER') await updateGate
        return originalImplementation(message)
      })
      await renderProviders()
      fireEvent.click(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' }))
      expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '路由设置' }))
      expect(screen.getByRole('switch', { name: 'Local API Router' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '关闭路由设置' }))
      expect(screen.getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      fireEvent.click(screen.getByRole('article', { name: 'OpenAI Provider' }))
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
      await act(async () => finishUpdate())
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeEnabled())
      expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeChecked()
    })

    it('saves the provider switch independently from model-test routing', async () => {
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
      const conversionSwitch = screen.getByRole('switch', { name: 'Provider format conversion' })
      const modelTestSwitch = screen.getByRole('switch', { name: 'Model test routing' })
      expect(conversionSwitch).not.toBeChecked()
      fireEvent.click(conversionSwitch)
      expect(modelTestSwitch).not.toBeChecked()
      fireEvent.click(modelTestSwitch)
      expect(conversionSwitch).toBeChecked()
      fireEvent.click(modelTestSwitch)
      expect(conversionSwitch).toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeChecked())
      expect(getMessages('UPDATE_PROVIDER')[0].payload).toMatchObject({ id: 'openai', updates: { format: 'openai', apiType: 'chat', formatConversionEnabled: true } })
      expect(getMessages('ENABLE_ROUTER')).toHaveLength(0)
      expect(getMessages('TEST_MODEL_VIA_ROUTER')).toHaveLength(0)
    })

    it('keeps edited conversion settings and the form open when saving fails', async () => {
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'UPDATE_PROVIDER'
        ? { success: false, error: 'Router unavailable' }
        : originalImplementation(message))
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Provider format conversion' }))
      fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
      await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not save provider: Router unavailable'))
      expect(screen.getByDisplayValue('OpenAI Provider')).toBeVisible()
      expect(screen.getByRole('switch', { name: 'Provider format conversion' })).toBeChecked()
      expect(screen.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
      expect(storedProviders[0].formatConversionEnabled).not.toBe(true)
    })

    it('reads the saved switch on edit and defaults new providers to off', async () => {
      storedProviders[0].formatConversionEnabled = true
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
      expect(screen.getByRole('switch', { name: 'Provider format conversion' })).toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
      expect(screen.getByRole('switch', { name: 'Provider format conversion' })).not.toBeChecked()
    })

    it('preserves conversion settings when duplicating a provider', async () => {
      storedProviders[0].formatConversionEnabled = true
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate OpenAI Provider' }))
      await waitFor(() => expect(getMessages('ADD_PROVIDER')).toHaveLength(1))
      expect(getMessages('ADD_PROVIDER')[0].payload).toMatchObject({ format: 'openai', apiType: 'chat', formatConversionEnabled: true })
      await waitFor(() => expect(within(switchProviderTab('anthropic')).getByRole('article', { name: 'OpenAI Provider (copy)' })).toBeVisible())
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
    })
  })

  describe('router conversion entries', () => {
    beforeEach(() => {
      routerStatus = { enabled: true, running: true, port: 15721 }
      storedProviders = storedProviders.map(provider => ({ ...provider, formatConversionEnabled: true }))
    })

    it.each([true, false])('shows one effective selection per tab with router enabled=%s', async enabled => {
      routerStatus = { enabled, running: enabled, port: 15721, clients: { openai: enabled, anthropic: enabled } }
      storedProviders = [
        makeProvider('o', 'Native OpenAI', { isActive: true, formatConversionEnabled: true, routerEffectiveFormats: ['openai'] }),
        makeProvider('a', 'Native Anthropic', { format: 'anthropic', isActive: true, formatConversionEnabled: true, routerEffectiveFormats: ['anthropic'] }),
      ]
      const panel = await renderProviders()
      expect(within(panel).getByRole('button', { name: 'Activate Native OpenAI' })).toHaveAttribute('aria-pressed', 'true')
      const anthropic = switchProviderTab('anthropic')
      expect(within(anthropic).getByRole('button', { name: 'Activate Native Anthropic' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(anthropic).getByRole('button', { name: 'Activate Native OpenAI' })).toHaveAttribute('aria-pressed', 'false')
    })

    it('highlights the converted entry only while that client is routed', async () => {
      routerStatus = { enabled: true, running: true, port: 15721, clients: { openai: true, anthropic: true } }
      storedProviders = [
        makeProvider('o', 'Native OpenAI', { isActive: true, formatConversionEnabled: true, routerActiveFormats: ['anthropic'], routerEffectiveFormats: ['anthropic'] }),
        makeProvider('a', 'Native Anthropic', { format: 'anthropic', isActive: true, formatConversionEnabled: true }),
      ]
      const panel = await renderProviders()
      const anthropic = switchProviderTab('anthropic')
      expect(within(anthropic).getByRole('button', { name: 'Activate Native OpenAI' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(anthropic).getByRole('button', { name: 'Activate Native Anthropic' })).toHaveAttribute('aria-pressed', 'false')
      const openaiPanel = switchProviderTab('openai')
      expect(within(openaiPanel).getByRole('button', { name: 'Activate Native OpenAI' })).toHaveAttribute('aria-pressed', 'true')
      // A converted Anthropic route does not deselect the source's OpenAI route.
      void panel
    })

    it('keeps all other tabs selected when independently toggling each client route', async () => {
      routerStatus = { enabled: true, running: true, port: 15721, clients: { openai: true, anthropic: true, deepseek: true } }
      storedProviders = [
        makeProvider('o', 'Native OpenAI', { isActive: true, formatConversionEnabled: true, routerActiveFormats: ['anthropic'], routerEffectiveFormats: ['anthropic'] }),
        makeProvider('a', 'Native Anthropic', { format: 'anthropic', isActive: true }),
        makeProvider('d', 'Native DeepSeek', { format: 'deepseek', isActive: true }),
      ]
      await renderProviders()
      const clients = { openai: true, anthropic: true, deepseek: true }
      for (const format of ['openai', 'anthropic', 'deepseek'] as const) {
        for (const enabled of [false, true]) {
          switchProviderTab(format)
          fireEvent.click(screen.getByRole('switch', { name: '使用路由' }))
          clients[format] = enabled
          await waitFor(() => {
            expect(screen.getByRole('switch', { name: '使用路由' })).toHaveAttribute('aria-checked', String(enabled))
            expect(screen.getByRole('switch', { name: '使用路由' })).toBeEnabled()
          })
          for (const other of ['openai', 'anthropic', 'deepseek'] as const) {
            const panel = switchProviderTab(other)
            expect(screen.getByRole('switch', { name: '使用路由' })).toHaveAttribute('aria-checked', String(clients[other]))
            const selectedName = other === 'anthropic' && clients.anthropic ? 'Native OpenAI'
              : other === 'openai' ? 'Native OpenAI' : other === 'anthropic' ? 'Native Anthropic' : 'Native DeepSeek'
            expect(within(panel).getByRole('button', { name: `Activate ${selectedName}` })).toHaveAttribute('aria-pressed', 'true')
            expect(within(panel).getAllByRole('button', { pressed: true })).toHaveLength(1)
          }
        }
      }
      expect(getMessages('SET_CLIENT_ROUTING').map(message => message.payload)).toEqual([
        { format: 'openai', enabled: false }, { format: 'openai', enabled: true },
        { format: 'anthropic', enabled: false }, { format: 'anthropic', enabled: true },
        { format: 'deepseek', enabled: false }, { format: 'deepseek', enabled: true },
      ])
    })

    it('highlights only the effective FS/Free route when provider IDs collide', async () => {
      routerStatus = { enabled: true, running: true, port: 15721, clients: { openai: true } }
      storedProviders = [
        makeProvider('duplicate', 'FS', { format: 'anthropic', formatConversionEnabled: true, routerActiveFormats: ['openai'] }),
        makeProvider('duplicate', 'Free', { isActive: true, routerEffectiveFormats: ['openai'] }),
      ]

      const panel = await renderProviders()

      expect(within(panel).getByRole('button', { name: 'Activate FS' })).toHaveAttribute('aria-pressed', 'false')
      expect(within(panel).getByRole('button', { name: 'Activate Free' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(panel).getAllByRole('button', { pressed: true })).toHaveLength(1)
    })

    it.each<ApiType>(['chat', 'responses', 'both'])('exposes an OpenAI %s provider as a Messages entry without changing its upstream', async apiType => {
      storedProviders = [makeProvider('source', 'Source Provider', {
        apiType,
        models: [
          { name: 'gpt-4.1', apiType, format: 'openai' },
          { name: 'gpt-4.1-mini', apiType, format: 'openai' },
        ],
        formatConversionEnabled: true,
      })]
      const original = structuredClone(storedProviders[0])
      const openaiPanel = await renderProviders()
      expect(getCardNames(openaiPanel)).toEqual(['Source Provider'])
      expect(within(openaiPanel).queryByText('Router')).not.toBeInTheDocument()

      const anthropicPanel = switchProviderTab('anthropic')
      const card = within(anthropicPanel).getByRole('article', { name: 'Source Provider' })
      expect(within(card).getByText('anthropic')).toBeVisible()
      expect(within(card).getByText('Router')).toHaveAttribute('title', expect.stringContaining('Messages via Router; upstream: openai'))
      expect(card).toHaveClass('rounded-lg', 'ring-2')
      expect(card.firstElementChild).toHaveClass('px-2.5', 'py-1.5')
      fireEvent.click(within(card).getByRole('button', { name: 'Choose model for Source Provider' }))
      expect(within(card).getByRole('button', { name: 'messages gpt-4.1-mini' })).toBeVisible()
      expect(within(card).queryByRole('button', { name: `${apiType} gpt-4.1-mini` })).not.toBeInTheDocument()
      const nativeCard = within(switchProviderTab('openai')).getByRole('article', { name: 'Source Provider' })
      fireEvent.click(within(nativeCard).getByRole('button', { name: 'Choose model for Source Provider' }))
      expect(within(nativeCard).getByRole('button', { name: `${apiType} gpt-4.1-mini` })).toBeVisible()
      expect(storedProviders).toEqual([original])
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it.each<ApiType>(['chat', 'responses', 'both'])('exposes Anthropic %s models as both OpenAI interfaces without changing the upstream', async apiType => {
      storedProviders = [makeProvider('source', 'Source Provider', {
        format: 'anthropic',
        apiType,
        models: [
          { name: 'claude-sonnet-4-5', apiType, format: 'anthropic' },
          { name: 'claude-opus-4-1', apiType, format: 'anthropic' },
        ],
        formatConversionEnabled: true,
      })]
      const original = structuredClone(storedProviders[0])
      const panel = await renderProviders()
      const card = within(panel).getByRole('article', { name: 'Source Provider' })
      expect(within(card).getByText('openai')).toBeVisible()
      expect(within(card).getByText('Router')).toBeVisible()
      fireEvent.click(within(card).getByRole('button', { name: 'Choose model for Source Provider' }))
      expect(within(card).getByRole('button', { name: 'both claude-opus-4-1' })).toBeVisible()
      const nativeCard = within(switchProviderTab('anthropic')).getByRole('article', { name: 'Source Provider' })
      fireEvent.click(within(nativeCard).getByRole('button', { name: 'Choose model for Source Provider' }))
      expect(within(nativeCard).getByRole('button', { name: 'messages claude-opus-4-1' })).toBeVisible()
      expect(storedProviders).toEqual([original])
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it('includes native and converted providers once per tab, including legacy OpenAI providers', async () => {
      storedProviders.push(makeProvider('legacy', 'Legacy Provider', { format: undefined, formatConversionEnabled: true }))
      const panel = await renderProviders()
      expect(getCardNames(panel)).toEqual(['OpenAI Provider', 'Anthropic Provider', 'Legacy Provider'])
      const converted = within(panel).getByRole('article', { name: 'Anthropic Provider' })
      expect(within(converted).getByText('openai')).toBeVisible()
      expect(within(converted).getByText('Router')).toHaveAttribute('title', expect.stringContaining('Chat Completions / Responses via Router; upstream: anthropic'))
      const anthropicPanel = switchProviderTab('anthropic')
      expect(getCardNames(anthropicPanel)).toEqual(['OpenAI Provider', 'Anthropic Provider', 'Legacy Provider'])
      expect(within(within(anthropicPanel).getByRole('article', { name: 'Anthropic Provider' })).queryByText('Router')).not.toBeInTheDocument()
      expect(within(within(anthropicPanel).getByRole('article', { name: 'Legacy Provider' })).getByText('Router')).toBeVisible()
    })

    it.each([
      { enabled: false, running: false },
      { enabled: false, running: true },
      { enabled: true, running: false },
    ])('keeps conversion entries disabled when enabled=$enabled and running=$running', async status => {
      routerStatus = { ...routerStatus, ...status }
      const openaiPanel = await renderProviders()
      expect(getCardNames(openaiPanel)).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(within(openaiPanel).getByRole('button', { name: 'Activate OpenAI Provider' })).toBeEnabled()
      const convertedAnthropic = within(openaiPanel).getByRole('article', { name: 'Anthropic Provider' })
      expect(within(convertedAnthropic).getByText('Router')).toHaveAttribute('title', expect.stringContaining('Enable the global Router first.'))
      expect(within(convertedAnthropic).getByRole('button', { name: 'Activate Anthropic Provider' })).toBeDisabled()
      fireEvent.click(convertedAnthropic)
      const anthropicPanel = switchProviderTab('anthropic')
      expect(getCardNames(anthropicPanel)).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(within(anthropicPanel).getByRole('button', { name: 'Activate Anthropic Provider' })).toBeEnabled()
      const convertedOpenai = within(anthropicPanel).getByRole('article', { name: 'OpenAI Provider' })
      expect(within(convertedOpenai).getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      fireEvent.click(convertedOpenai)
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { id: 'openai', name: 'OpenAI Provider', nativeTab: 'openai', targetTab: 'anthropic' },
      { id: 'anthropic', name: 'Anthropic Provider', nativeTab: 'anthropic', targetTab: 'openai' },
    ] as const)('activates the original $id provider from its conversion entry', async testCase => {
      routerStatus.clients = { [testCase.targetTab]: true }
      const original = structuredClone(storedProviders.find(provider => provider.id === testCase.id)!)
      await renderProviders()
      switchProviderTab(testCase.targetTab)
      fireEvent.click(screen.getByRole('button', { name: `Activate ${testCase.name}` }))
      await waitFor(() => {
        expect(getMessages('SET_ACTIVE_PROVIDER')).toEqual([
          { type: 'SET_ACTIVE_PROVIDER', payload: { id: testCase.id, sync: true, targetFormat: testCase.targetTab } },
        ])
        expect(screen.getByRole('button', { name: `Activate ${testCase.name}` })).toHaveAttribute('aria-pressed', 'true')
      })
      switchProviderTab(testCase.nativeTab)
      expect(screen.getByRole('button', { name: `Activate ${testCase.name}` })).toHaveAttribute('aria-pressed', 'false')
      expect(storedProviders.find(provider => provider.id === testCase.id)).toEqual({ ...original, routerActiveFormats: [testCase.targetTab] })
      expect(storedProviders).toHaveLength(2)
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it('keeps conversion entries with the global router and clears selections when toggling it', async () => {
      routerStatus = { enabled: false, running: false, port: 15721 }
      storedProviders[0].isActive = true
      await renderProviders()
      const panel = switchProviderTab('anthropic')
      const providerSection = within(panel.parentElement!)
      const selectButton = providerSection.getByRole('button', { name: 'Select' })
      const toolbar = within(selectButton.parentElement!)
      expect(getCardNames(panel)).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(within(panel).getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '路由设置' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Local API Router' }))
      fireEvent.click(screen.getByRole('button', { name: '关闭路由设置' }))
      await waitFor(() => expect(within(panel).getByRole('button', { name: 'Activate OpenAI Provider' })).toBeEnabled())
      fireEvent.click(selectButton)
      fireEvent.click(within(panel).getByRole('checkbox', { name: 'Select OpenAI Provider' }))
      expect(toolbar.getByRole('button', { name: 'Del (1)' })).toBeVisible()

      fireEvent.click(screen.getByRole('button', { name: '路由设置' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Local API Router' }))
      await waitFor(() => {
        expect(screen.getByRole('switch', { name: 'Local API Router' })).not.toBeChecked()
        expect(toolbar.queryByRole('button', { name: 'Del (1)' })).not.toBeInTheDocument()
      })
      fireEvent.click(screen.getByRole('button', { name: '关闭路由设置' }))
      expect(within(panel).getByRole('checkbox', { name: 'Select Anthropic Provider' })).not.toBeChecked()
      fireEvent.click(toolbar.getByRole('button', { name: 'Exit selection mode' }))
      expect(within(panel).getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      expect(within(getProviderTab('openai')).getByText('2')).toBeVisible()
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
    })

    it('does not expose conversion entries when only the model-test router switch is enabled', async () => {
      routerStatus = { enabled: false, running: false, port: 15721 }
      storedProviders = storedProviders.map(provider => ({ ...provider, formatConversionEnabled: false }))
      await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Model test routing' }))
      expect(screen.getByRole('switch', { name: 'Model test routing' })).toBeChecked()
      // Format tabs belong to the home page, not the provider editor.
      expect(screen.queryByRole('tab', { name: 'OpenAI' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Close provider editor' }))
      expect(getCardNames(screen.getByRole('tabpanel', { name: 'OpenAI' }))).toEqual(['OpenAI Provider'])
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic Provider'])
      expect(getMessages('ENABLE_ROUTER')).toHaveLength(0)
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { id: 'openai', name: 'OpenAI Provider', format: 'openai', targetFormat: 'anthropic', model: 'gpt-4.1-mini', targetType: 'messages' },
      { id: 'anthropic', name: 'Anthropic Provider', format: 'anthropic', targetFormat: 'openai', model: 'claude-opus-4-1', targetType: 'both' },
    ] as const)('switches the original $format model from a conversion entry and reflects it in its native tab', async testCase => {
      const source = storedProviders.find(provider => provider.id === testCase.id)!
      source.models.push({ name: testCase.model, apiType: 'chat', format: testCase.format })
      const originalModels = structuredClone(source.models)
      await renderProviders()
      switchProviderTab(testCase.targetFormat)
      fireEvent.click(screen.getByRole('button', { name: `Choose model for ${testCase.name}` }))
      fireEvent.click(screen.getByRole('button', { name: `${testCase.targetType} ${testCase.model}` }))
      await waitFor(() => expect(storedProviders.find(provider => provider.id === testCase.id)?.model).toBe(testCase.model))
      switchProviderTab(testCase.format)
      expect(within(screen.getByRole('article', { name: testCase.name })).getByText(testCase.model)).toBeVisible()
      expect(storedProviders.find(provider => provider.id === testCase.id)).toMatchObject({
        format: testCase.format, apiType: 'chat', models: originalModels,
      })
      expect(getMessages('UPDATE_PROVIDER')[0].payload.updates).not.toHaveProperty('format')
      expect(getMessages('UPDATE_PROVIDER')[0].payload.updates).not.toHaveProperty('apiType')
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { format: 'openai', apiType: 'chat', targetFormat: 'anthropic', targetType: 'messages' },
      { format: 'openai', apiType: 'responses', targetFormat: 'anthropic', targetType: 'messages' },
      { format: 'openai', apiType: 'both', targetFormat: 'anthropic', targetType: 'messages' },
      { format: 'anthropic', apiType: 'chat', targetFormat: 'openai', targetType: 'both' },
    ] as const)('shows a read-only $targetFormat view for an upstream $format/$apiType provider', async testCase => {
      const model = testCase.format === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'
      const models = [{ name: model, apiType: testCase.apiType, format: testCase.format }]
      storedProviders = [makeProvider('source', 'Source Provider', {
        format: testCase.format,
        apiType: testCase.apiType,
        models,
        groupModels: { default: models },
        formatConversionEnabled: true,
      })]
      const original = structuredClone(storedProviders[0])
      await renderProviders()
      switchProviderTab(testCase.targetFormat)
      fireEvent.click(screen.getByRole('button', { name: 'Edit Source Provider' }))
      const form = screen.getByRole('form', { name: 'Provider settings' })
      const targetFormat = testCase.targetFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'
      expect(within(form).getByDisplayValue(targetFormat)).toBeDisabled()
      expect(within(form).getByDisplayValue('Source Provider')).toBeDisabled()
      expect(within(form).getByDisplayValue('https://api.example.com/v1')).toBeDisabled()
      const targetModelType = within(form).getByTitle(testCase.targetFormat === 'anthropic' ? 'messages' : 'Click to toggle apiType')
      expect(targetModelType).toHaveTextContent(testCase.targetType)
      expect(targetModelType).toBeDisabled()
      expect(within(form).getAllByText(model)[0]).toBeVisible()
      expect(within(form).getByRole('combobox', { name: 'Test model' })).toBeEnabled()
      expect(within(form).getByRole('button', { name: 'Test', exact: true })).toBeEnabled()
      expect(within(form).queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument()
      expect(within(form).queryByRole('switch', { name: 'Model test routing' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '一键导入' })).toBeDisabled()
      fireEvent.submit(form)
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
      expect(storedProviders).toEqual([original])

      fireEvent.click(within(form).getByRole('button', { name: '编辑原生 Provider' }))
      expect(within(form).getByDisplayValue(testCase.format === 'anthropic' ? 'Anthropic' : 'OpenAI')).toBeEnabled()
      const sourceModelType = within(form).getByTitle(testCase.format === 'anthropic' ? 'messages' : 'Click to toggle apiType')
      expect(sourceModelType).toHaveTextContent(testCase.format === 'anthropic' ? 'msg' : testCase.apiType)
      expect(sourceModelType).toBeEnabled()
      expect(within(form).getByRole('switch', { name: 'Model test routing' })).not.toBeChecked()
      fireEvent.change(within(form).getByDisplayValue('Source Provider'), { target: { value: 'Edited Source' } })
      fireEvent.click(within(form).getByRole('button', { name: 'Save', exact: true }))
      await waitFor(() => expect(getMessages('UPDATE_PROVIDER')).toHaveLength(1))
      expect(getMessages('UPDATE_PROVIDER')[0].payload).toMatchObject({
        id: 'source',
        updates: { name: 'Edited Source', format: testCase.format, apiType: testCase.apiType, models },
      })
      await screen.findByRole('article', { name: 'Edited Source' })
      expect(form.closest('.transform')).toHaveClass('translate-x-full')
      expect(getCardNames(switchProviderTab(testCase.targetFormat))).toEqual(['Edited Source'])
      expect(getCardNames(switchProviderTab(testCase.format))).toEqual(['Edited Source'])
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { sourceFormat: 'openai', sourceApiType: 'chat', targetFormat: 'anthropic', upstream: 'Chat' },
      { sourceFormat: 'openai', sourceApiType: 'responses', targetFormat: 'anthropic', upstream: 'Responses' },
      { sourceFormat: 'openai', sourceApiType: 'both', targetFormat: 'anthropic', upstream: 'Responses' },
      { sourceFormat: 'anthropic', sourceApiType: 'chat', targetFormat: 'openai', upstream: 'Messages' },
    ] as const)('tests selected models in the read-only $targetFormat panel using native $sourceFormat/$sourceApiType settings', async testCase => {
      const currentModels = [
        { name: 'current-model', apiType: testCase.sourceApiType, format: testCase.sourceFormat },
        { name: 'alternate-model', apiType: testCase.sourceApiType, format: testCase.sourceFormat },
      ]
      storedProviders = [makeProvider('source', 'Source Provider', {
        format: testCase.sourceFormat,
        apiType: 'both',
        model: 'current-model',
        models: [{ name: 'alternate-model', apiType: 'both', format: testCase.sourceFormat }],
        groupModels: {
          default: [{ name: 'default-model', apiType: 'chat', format: testCase.sourceFormat }],
          paid: currentModels,
        },
        groupApiKeys: { default: 'default-key', paid: 'group-key' },
        apiKey: 'group-key',
        activeGroup: 'paid',
        formatConversionEnabled: true,
      })]
      const original = structuredClone(storedProviders[0])
      const endpointLabels = testCase.targetFormat === 'anthropic' ? ['messages'] : ['chat', 'responses']
      const testResult = {
        success: true,
        message: 'OK',
        responseBody: 'final-response',
        endpoints: endpointLabels.map(label => ({
          label, success: true, statusCode: 200,
          convertedFrom: testCase.upstream.toLowerCase(),
          responseBody: `final-${label}-response`,
        })),
      }
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'TEST_MODEL_VIA_ROUTER'
        ? { success: true, data: testResult }
        : originalImplementation(message))
      await renderProviders()
      switchProviderTab(testCase.targetFormat)
      fireEvent.click(screen.getByRole('button', { name: 'Edit Source Provider' }))
      const form = screen.getByRole('form', { name: 'Provider settings' })
      const selector = within(form).getByRole('combobox', { name: 'Test model' })
      expect(selector).toHaveValue('current-model')
      expect(within(selector).getAllByRole('option').map(option => option.textContent)).toEqual(['current-model', 'alternate-model'])
      fireEvent.change(selector, { target: { value: 'alternate-model' } })
      fireEvent.click(within(form).getByRole('button', { name: 'Test', exact: true }))

      for (const label of endpointLabels) {
        fireEvent.click(await within(form).findByRole('button', { name: `${label} 200 OK via ${testCase.upstream}` }))
        fireEvent.click(within(form).getByRole('button', { name: `Copy final ${label} response` }))
        await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(`final-${label}-response`))
      }
      expect(getMessages('TEST_MODEL_VIA_ROUTER')).toEqual([{
        type: 'TEST_MODEL_VIA_ROUTER',
        payload: { ...original, model: 'alternate-model', models: currentModels, apiType: testCase.sourceApiType, targetFormat: testCase.targetFormat },
      }])
      expect(within(form).queryByText(/undefined/)).not.toBeInTheDocument()
      expect(within(form).queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument()
      fireEvent.submit(form)
      for (const type of ['TEST_PROVIDER', 'UPDATE_PROVIDER', 'ADD_PROVIDER', 'SET_ACTIVE_PROVIDER', 'UPDATE_TEST_STATUS', 'ENABLE_ROUTER']) {
        expect(getMessages(type)).toHaveLength(0)
      }
      expect(storedProviders).toEqual([original])
      fireEvent.change(selector, { target: { value: 'current-model' } })
      expect(within(form).queryByText('Partial/Full OK')).not.toBeInTheDocument()
      expect(within(form).queryByRole('button', { name: /Copy final/ })).not.toBeInTheDocument()
    })

    it('allows Router model testing while the global router is off and displays Native Host errors', async () => {
      routerStatus = { enabled: false, running: false, port: 15721 }
      let finishTest: (value: unknown) => void = () => {}
      const pendingTest = new Promise(resolve => { finishTest = resolve })
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'TEST_MODEL_VIA_ROUTER'
        ? pendingTest
        : originalImplementation(message))
      const original = structuredClone(storedProviders)
      await renderProviders()
      switchProviderTab('anthropic')
      fireEvent.click(screen.getByRole('button', { name: 'Edit OpenAI Provider' }))
      const form = screen.getByRole('form', { name: 'Provider settings' })
      const selector = within(form).getByRole('combobox', { name: 'Test model' })
      expect(selector).toHaveValue(original[0].model)
      fireEvent.click(within(form).getByRole('button', { name: 'Test', exact: true }))
      expect(selector).toBeDisabled()
      expect(within(form).getByRole('button', { name: 'Testing' })).toBeDisabled()
      expect(within(form).getByRole('button', { name: '编辑原生 Provider' })).toBeDisabled()
      await act(async () => { finishTest({ success: false, error: 'Native messaging host not found' }) })
      expect(await within(form).findByText('Native messaging host not found')).toBeVisible()
      expect(selector).toBeEnabled()
      expect(within(form).getByRole('button', { name: 'Test', exact: true })).toBeEnabled()
      expect(getMessages('TEST_MODEL_VIA_ROUTER')[0].payload).toEqual({ ...original[0], targetFormat: 'anthropic' })
      expect(getMessages('TEST_PROVIDER')).toHaveLength(0)
      expect(getMessages('ENABLE_ROUTER')).toHaveLength(0)
      expect(storedProviders).toEqual(original)
    })

    it.each<ProviderFormat>(['openai', 'anthropic'])('duplicates and shares the source %s configuration from a Router entry', async format => {
      const source = makeProvider('source', 'Source Provider', { format, apiType: 'chat', formatConversionEnabled: true })
      storedProviders = [source]
      await renderProviders()
      const targetFormat = format === 'anthropic' ? 'openai' : 'anthropic'
      switchProviderTab(targetFormat)
      const card = screen.getByRole('article', { name: 'Source Provider' })
      fireEvent.click(within(card).getByRole('button', { name: 'Share Source Provider' }))
      await waitFor(() => expect(writeTextMock).toHaveBeenCalledTimes(1))
      const exported = JSON.parse(writeTextMock.mock.calls[0][0])
      expect(exported.providers[0]).toMatchObject({ format, apiType: source.apiType, models: source.models })
      fireEvent.click(within(card).getByRole('button', { name: 'Duplicate Source Provider' }))
      await waitFor(() => expect(getMessages('ADD_PROVIDER')).toHaveLength(1))
      expect(getMessages('ADD_PROVIDER')[0].payload).toMatchObject({ format, apiType: source.apiType, models: source.models })
      await screen.findByRole('article', { name: 'Source Provider (copy)' })
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
    })

    it.each([
      { id: 'openai', name: 'OpenAI Provider', nativeTab: 'openai', targetTab: 'anthropic' },
      { id: 'anthropic', name: 'Anthropic Provider', nativeTab: 'anthropic', targetTab: 'openai' },
      { id: 'legacy', name: 'Legacy Provider', nativeTab: 'openai', targetTab: 'anthropic' },
    ] as const)('removes the Router entry for $id without deleting or changing the original configuration', async testCase => {
      if (testCase.id === 'legacy') {
        storedProviders.push(makeProvider('legacy', 'Legacy Provider', { format: undefined, formatConversionEnabled: true }))
      }
      storedProviders = storedProviders.map(provider => ({
        ...provider,
        isActive: provider.id === testCase.id,
        groupModels: { default: provider.models! },
      }))
      const originals = structuredClone(storedProviders)
      await renderProviders()
      const targetPanel = switchProviderTab(testCase.targetTab)
      const removeButton = within(targetPanel).getByRole('button', { name: `Remove Router entry for ${testCase.name}` })
      expect(removeButton).toHaveAttribute('title', expect.stringContaining('keep the original provider'))
      fireEvent.click(removeButton)
      await waitFor(() => expect(within(targetPanel).queryByRole('article', { name: testCase.name })).not.toBeInTheDocument())
      expect(storedProviders).toEqual(originals.map(provider => provider.id === testCase.id
        ? { ...provider, formatConversionEnabled: false }
        : provider))
      expect(getMessages('UPDATE_PROVIDER')).toEqual([
        { type: 'UPDATE_PROVIDER', payload: { id: testCase.id, updates: { formatConversionEnabled: false } } },
      ])
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      const nativeCard = within(switchProviderTab(testCase.nativeTab)).getByRole('article', { name: testCase.name })
      expect(nativeCard).toBeVisible()
      expect(within(nativeCard).getByRole('switch', { name: `Format conversion for ${testCase.name}` })).not.toBeChecked()
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
      expect(getMessages('DISABLE_ROUTER')).toHaveLength(0)
    })

    it('can remove a Router entry while the global router is disabled', async () => {
      routerStatus = { enabled: false, running: false, port: 15721 }
      const original = structuredClone(storedProviders[0])
      await renderProviders()
      const panel = switchProviderTab('anthropic')
      expect(screen.getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Remove Router entry for OpenAI Provider' }))
      await waitFor(() => expect(within(panel).queryByRole('article', { name: 'OpenAI Provider' })).not.toBeInTheDocument())
      expect(storedProviders[0]).toEqual({ ...original, formatConversionEnabled: false })
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      expect(getMessages('ENABLE_ROUTER')).toHaveLength(0)
    })

    it.each([
      { id: 'openai', name: 'OpenAI Provider', nativeTab: 'openai', targetTab: 'anthropic' },
      { id: 'anthropic', name: 'Anthropic Provider', nativeTab: 'anthropic', targetTab: 'openai' },
    ] as const)('deletes the native $id provider and removes its entry from both tabs', async testCase => {
      await renderProviders()
      const nativePanel = switchProviderTab(testCase.nativeTab)
      fireEvent.click(screen.getByRole('button', { name: `Delete ${testCase.name}` }))
      await waitFor(() => expect(within(nativePanel).queryByRole('article', { name: testCase.name })).not.toBeInTheDocument())
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: testCase.id }])
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
      expect(storedProviders).toHaveLength(1)
      expect(within(switchProviderTab(testCase.targetTab)).queryByRole('article', { name: testCase.name })).not.toBeInTheDocument()
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
    })

    it.each<ProviderFormat>(['openai', 'anthropic'])('only deletes native configurations when bulk removing mixed entries in the %s tab', async format => {
      const original = structuredClone(storedProviders.find(provider => provider.format !== format)!)
      const native = storedProviders.find(provider => provider.format === format)!
      await renderProviders()
      const panel = switchProviderTab(format)
      const selectButton = screen.getByRole('button', { name: 'Select' })
      const toolbar = selectButton.parentElement!
      fireEvent.click(selectButton)
      fireEvent.click(within(toolbar).getByRole('button', { name: 'All' }))
      expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: 'Del (2)' }))
      await waitFor(() => {
        expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: native.id }])
        expect(storedProviders).toEqual([{ ...original, formatConversionEnabled: false }])
        expect(getCardNames(panel)).toEqual([])
      })
      expect(getMessages('UPDATE_PROVIDER')).toEqual([
        { type: 'UPDATE_PROVIDER', payload: { id: original.id, updates: { formatConversionEnabled: false } } },
      ])
      expect(getCardNames(switchProviderTab(format === 'openai' ? 'anthropic' : 'openai'))).toEqual([original.name])
      expect(getMessages('SET_ACTIVE_PROVIDER')).toHaveLength(0)
    })

    it('bulk removes multiple Router entries without deleting any original providers', async () => {
      storedProviders = [
        storedProviders[0],
        makeProvider('openai-second', 'OpenAI Second', { formatConversionEnabled: true }),
      ]
      const originals = structuredClone(storedProviders)
      await renderProviders()
      const panel = switchProviderTab('anthropic')
      const selectButton = screen.getByRole('button', { name: 'Select' })
      const toolbar = within(selectButton.parentElement!)
      fireEvent.click(selectButton)
      fireEvent.click(toolbar.getByRole('button', { name: 'All' }))
      fireEvent.click(toolbar.getByRole('button', { name: 'Del (2)' }))
      await waitFor(() => expect(getCardNames(panel)).toEqual([]))
      expect(getMessages('UPDATE_PROVIDER')).toEqual(originals.map(provider => ({
        type: 'UPDATE_PROVIDER',
        payload: { id: provider.id, updates: { formatConversionEnabled: false } },
      })))
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      expect(storedProviders).toEqual(originals.map(provider => ({ ...provider, formatConversionEnabled: false })))
      expect(getCardNames(switchProviderTab('openai'))).toEqual(['OpenAI Provider', 'OpenAI Second'])
    })

    it.each(['response', 'rejection'] as const)('keeps the Router entry and original configuration after an update %s and allows retry', async failure => {
      const originals = structuredClone(storedProviders)
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => {
        if (message.type === 'UPDATE_PROVIDER') {
          if (failure === 'rejection') throw new Error('Router unavailable')
          return { success: false, error: 'Router unavailable' }
        }
        return originalImplementation(message)
      })
      await renderProviders()
      const panel = switchProviderTab('anthropic')
      fireEvent.click(screen.getByRole('button', { name: 'Remove Router entry for OpenAI Provider' }))
      await waitFor(() => {
        expect(alert).toHaveBeenCalledWith(expect.stringContaining('Router unavailable'))
        expect(screen.getByRole('button', { name: 'Remove Router entry for OpenAI Provider' })).toBeEnabled()
      })
      expect(storedProviders).toEqual(originals)
      expect(getCardNames(panel)).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      sendMessageMock.mockImplementation(originalImplementation)
      fireEvent.click(screen.getByRole('button', { name: 'Remove Router entry for OpenAI Provider' }))
      await waitFor(() => expect(getCardNames(panel)).toEqual(['Anthropic Provider']))
      expect(storedProviders[0]).toEqual({ ...originals[0], formatConversionEnabled: false })
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
    })

    it('preserves native and Router entries when deleting the original provider fails', async () => {
      const originals = structuredClone(storedProviders)
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'DELETE_PROVIDER'
        ? { success: false, error: 'Storage unavailable' }
        : originalImplementation(message))
      const panel = await renderProviders()
      fireEvent.click(screen.getByRole('button', { name: 'Delete OpenAI Provider' }))
      await waitFor(() => {
        expect(alert).toHaveBeenCalledWith('Could not delete provider OpenAI Provider: Storage unavailable')
        expect(screen.getByRole('button', { name: 'Delete OpenAI Provider' })).toBeEnabled()
      })
      expect(storedProviders).toEqual(originals)
      expect(getCardNames(panel)).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(0)
    })

    it('keeps only failed bulk items selected and retries without deleting their originals', async () => {
      const original = structuredClone(storedProviders[1])
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'UPDATE_PROVIDER'
        ? { success: false, error: 'Router unavailable' }
        : originalImplementation(message))
      const panel = await renderProviders()
      const selectButton = screen.getByRole('button', { name: 'Select' })
      const toolbar = within(selectButton.parentElement!)
      fireEvent.click(selectButton)
      fireEvent.click(toolbar.getByRole('button', { name: 'All' }))
      fireEvent.click(toolbar.getByRole('button', { name: 'Del (2)' }))
      await waitFor(() => {
        expect(alert).toHaveBeenCalledWith('Could not remove Router entry for Anthropic Provider: Router unavailable')
        expect(getCardNames(panel)).toEqual(['Anthropic Provider'])
        expect(toolbar.getByRole('button', { name: 'Del (1)' })).toBeEnabled()
      })
      expect(screen.getByRole('checkbox', { name: 'Select Anthropic Provider' })).toBeChecked()
      expect(storedProviders).toEqual([original])
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: 'openai' }])
      sendMessageMock.mockImplementation(originalImplementation)
      fireEvent.click(toolbar.getByRole('button', { name: 'Del (1)' }))
      await waitFor(() => expect(getCardNames(panel)).toEqual([]))
      expect(storedProviders).toEqual([{ ...original, formatConversionEnabled: false }])
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: 'openai' }])
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic Provider'])
    })

    it('stops a mixed bulk removal when updating a Router entry fails', async () => {
      const originals = structuredClone(storedProviders)
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'UPDATE_PROVIDER'
        ? { success: false, error: 'Router unavailable' }
        : originalImplementation(message))
      await renderProviders()
      switchProviderTab('anthropic')
      const selectButton = screen.getByRole('button', { name: 'Select' })
      const toolbar = within(selectButton.parentElement!)
      fireEvent.click(selectButton)
      fireEvent.click(toolbar.getByRole('button', { name: 'All' }))
      fireEvent.click(toolbar.getByRole('button', { name: 'Del (2)' }))
      await waitFor(() => {
        expect(alert).toHaveBeenCalledWith('Could not remove Router entry for OpenAI Provider: Router unavailable')
        expect(toolbar.getByRole('button', { name: 'Del (2)' })).toBeEnabled()
      })
      expect(storedProviders).toEqual(originals)
      expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(2)
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
    })

    it('blocks duplicate removal and router changes while removing a Router entry', async () => {
      let finishUpdate = () => {}
      const updateGate = new Promise<void>(resolve => { finishUpdate = resolve })
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => {
        if (message.type === 'UPDATE_PROVIDER') await updateGate
        return originalImplementation(message)
      })
      await renderProviders()
      switchProviderTab('anthropic')
      const removeButton = screen.getByRole('button', { name: 'Remove Router entry for OpenAI Provider' })
      fireEvent.click(removeButton)
      expect(removeButton).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '路由设置' }))
      expect(screen.getByRole('switch', { name: 'Local API Router' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '关闭路由设置' }))
      expect(screen.getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled()
      fireEvent.click(removeButton)
      switchProviderTab('openai')
      const nativeDeleteButton = screen.getByRole('button', { name: 'Delete OpenAI Provider' })
      expect(nativeDeleteButton).toBeDisabled()
      expect(screen.getByRole('switch', { name: 'Format conversion for OpenAI Provider' })).toBeDisabled()
      fireEvent.click(nativeDeleteButton)
      expect(getMessages('UPDATE_PROVIDER')).toHaveLength(1)
      expect(getMessages('DELETE_PROVIDER')).toHaveLength(0)
      await act(async () => { finishUpdate() })
      await waitFor(() => expect(nativeDeleteButton).toBeEnabled())
      expect(storedProviders.find(provider => provider.id === 'openai')).toMatchObject({ formatConversionEnabled: false })
      expect(storedProviders).toHaveLength(2)
    })

    it('keeps bulk deletion scoped to the original tab while preventing duplicate requests', async () => {
      let finishDelete = () => {}
      const deleteGate = new Promise<void>(resolve => { finishDelete = resolve })
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => {
        if (message.type === 'DELETE_PROVIDER') await deleteGate
        return originalImplementation(message)
      })
      await renderProviders()
      const selectButton = screen.getByRole('button', { name: 'Select' })
      const toolbar = within(selectButton.parentElement!)
      fireEvent.click(selectButton)
      fireEvent.click(toolbar.getByRole('button', { name: 'All' }))
      const deleteButton = toolbar.getByRole('button', { name: 'Del (2)' })
      fireEvent.click(deleteButton)
      expect(deleteButton).toBeDisabled()
      expect(toolbar.getByRole('button', { name: 'Deselect' })).toBeDisabled()
      expect(toolbar.getByRole('button', { name: 'Exit selection mode' })).toBeDisabled()
      fireEvent.click(deleteButton)
      const panel = switchProviderTab('anthropic')
      await act(async () => { finishDelete() })
      await waitFor(() => {
        expect(getCardNames(panel)).toEqual(['Anthropic Provider'])
        expect(screen.getByRole('button', { name: 'Select' })).toBeEnabled()
      })
      expect(getMessages('DELETE_PROVIDER')).toEqual([{ type: 'DELETE_PROVIDER', payload: 'openai' }])
      expect(getMessages('UPDATE_PROVIDER')).toEqual([
        { type: 'UPDATE_PROVIDER', payload: { id: 'anthropic', updates: { formatConversionEnabled: false } } },
      ])
      expect(storedProviders).toHaveLength(1)
    })

    it.each(['openai', 'anthropic'] as const)('tests each provider once using its displayed %s entry in Test All', async targetFormat => {
      const convertedSource = structuredClone(storedProviders.find(provider => provider.format !== targetFormat)!)
      const nativeSource = structuredClone(storedProviders.find(provider => provider.format === targetFormat)!)
      const otherNativeSource = makeProvider('native-only', 'Native Only', { format: convertedSource.format })
      storedProviders.push(otherNativeSource)
      const testResult = { success: true, message: 'Converted format OK', statusCode: 200 }
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'TEST_MODEL_VIA_ROUTER'
        ? { success: true, data: testResult }
        : originalImplementation(message))
      await renderProviders()
      switchProviderTab(targetFormat)
      fireEvent.click(screen.getByRole('button', { name: 'Test All' }))
      await waitFor(() => {
        expect(getMessages('TEST_PROVIDER').map(message => message.payload.id)).toEqual([nativeSource.id, otherNativeSource.id])
        expect(getMessages('UPDATE_TEST_STATUS')).toEqual([{ type: 'UPDATE_TEST_STATUS', payload: { id: convertedSource.id, result: testResult } }])
        expect(screen.getByRole('button', { name: 'Test All' })).toBeEnabled()
      })
      expect(getMessages('TEST_MODEL_VIA_ROUTER')).toEqual([{ type: 'TEST_MODEL_VIA_ROUTER', payload: { ...convertedSource, targetFormat } }])
      expect(storedProviders).toEqual(expect.arrayContaining([convertedSource, nativeSource, otherNativeSource]))
    })

    it.each([
      { sourceFormat: 'openai', targetFormat: 'anthropic', sourceApiType: 'chat' },
      { sourceFormat: 'openai', targetFormat: 'anthropic', sourceApiType: 'responses' },
      { sourceFormat: 'openai', targetFormat: 'anthropic', sourceApiType: 'both' },
      { sourceFormat: 'anthropic', targetFormat: 'openai', sourceApiType: 'chat' },
    ] as const)('tests the $sourceFormat/$sourceApiType Router entry using its native settings and the target format', async testCase => {
      const source = makeProvider('source', 'Source Provider', {
        format: testCase.sourceFormat,
        apiType: testCase.sourceApiType,
        models: [{ name: 'test-model', apiType: testCase.sourceApiType, format: testCase.sourceFormat }],
        model: 'test-model',
        formatConversionEnabled: true,
      })
      storedProviders = [source]
      const testResult = {
        success: false,
        statusCode: 404,
        message: 'Responses unavailable; Chat fallback succeeded',
        responseBody: '{"fallback":"chat"}',
      }
      const originalImplementation = sendMessageMock.getMockImplementation()!
      sendMessageMock.mockImplementation(async message => message.type === 'TEST_MODEL_VIA_ROUTER'
        ? { success: true, data: testResult }
        : originalImplementation(message))

      await renderProviders()
      const panel = switchProviderTab(testCase.targetFormat)
      fireEvent.click(within(panel).getByRole('button', { name: 'Test Source Provider via Router' }))

      await waitFor(() => expect(getMessages('UPDATE_TEST_STATUS')).toHaveLength(1))
      expect(getMessages('TEST_MODEL_VIA_ROUTER')).toEqual([
        expect.objectContaining({
          payload: { ...source, targetFormat: testCase.targetFormat },
        }),
      ])
      expect(getMessages('TEST_PROVIDER')).toHaveLength(0)
      expect(getMessages('UPDATE_TEST_STATUS')[0].payload).toEqual({ id: source.id, result: testResult })
    })

    it('reorders conversion entries within their original format without moving native entries', async () => {
      storedProviders.push(makeProvider('openai-second', 'OpenAI Second', { formatConversionEnabled: true }))
      await renderProviders()
      switchProviderTab('anthropic')
      fireEvent.dragStart(screen.getByRole('article', { name: 'OpenAI Provider' }))
      fireEvent.dragOver(screen.getByRole('article', { name: 'OpenAI Second' }))
      expect(screen.getByRole('article', { name: 'Anthropic Provider' })).not.toHaveClass('translate-y-1')
      fireEvent.drop(screen.getByRole('article', { name: 'OpenAI Second' }))
      await waitFor(() => expect(getMessages('REORDER_PROVIDERS')).toEqual([
        { type: 'REORDER_PROVIDERS', payload: ['openai-second', 'anthropic', 'openai'] },
      ]))
      expect(getCardNames(screen.getByRole('tabpanel'))).toEqual(['OpenAI Second', 'Anthropic Provider', 'OpenAI Provider'])
      expect(getCardNames(switchProviderTab('openai'))).toEqual(['OpenAI Second', 'Anthropic Provider', 'OpenAI Provider'])
    })

    it('ignores cross-upstream-format drops even when both cards appear in a routed tab', async () => {
      await renderProviders()
      switchProviderTab('anthropic')
      fireEvent.dragStart(screen.getByRole('article', { name: 'OpenAI Provider' }))
      fireEvent.dragOver(screen.getByRole('article', { name: 'Anthropic Provider' }))
      fireEvent.drop(screen.getByRole('article', { name: 'Anthropic Provider' }))
      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
      expect(getCardNames(screen.getByRole('tabpanel'))).toEqual(['OpenAI Provider', 'Anthropic Provider'])
    })

    it('clears dropdown and drag state when disabling the router', async () => {
      storedProviders[0].models!.push({ name: 'gpt-4.1-mini', apiType: 'chat', format: 'openai' })
      await renderProviders()
      switchProviderTab('anthropic')
      fireEvent.click(screen.getByRole('button', { name: 'Choose model for OpenAI Provider' }))
      fireEvent.dragStart(screen.getByRole('article', { name: 'OpenAI Provider' }))
      fireEvent.click(screen.getByRole('button', { name: '路由设置' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Local API Router' }))
      fireEvent.click(screen.getByRole('button', { name: '关闭路由设置' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Activate OpenAI Provider' })).toBeDisabled())
      expect(getCardNames(screen.getByRole('tabpanel'))).toEqual(['OpenAI Provider', 'Anthropic Provider'])
      switchProviderTab('openai')
      expect(screen.getByRole('article', { name: 'OpenAI Provider' })).not.toHaveClass('opacity-30')
      expect(screen.getByRole('button', { name: 'Choose model for OpenAI Provider' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'chat gpt-4.1-mini' })).not.toBeInTheDocument()
      fireEvent.drop(screen.getByRole('article', { name: 'OpenAI Provider' }))
      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
    })
  })

  describe('grouped drag ordering', () => {
    beforeEach(() => {
      storedProviders = [
        makeProvider('openai-first', 'OpenAI First'),
        makeProvider('anthropic-first', 'Anthropic First', { format: 'anthropic' }),
        makeProvider('openai-second', 'OpenAI Second'),
        makeProvider('anthropic-second', 'Anthropic Second', { format: 'anthropic' }),
        makeProvider('openai-third', 'OpenAI Third'),
      ]
    })

    it.each([
      {
        source: 'OpenAI First', target: 'OpenAI Third',
        expectedIds: ['openai-second', 'anthropic-first', 'openai-third', 'anthropic-second', 'openai-first'],
        expectedOpenai: ['OpenAI Second', 'OpenAI Third', 'OpenAI First'],
        expectedAnthropic: ['Anthropic First', 'Anthropic Second'],
      },
      {
        source: 'OpenAI Third', target: 'OpenAI First',
        expectedIds: ['openai-third', 'anthropic-first', 'openai-first', 'anthropic-second', 'openai-second'],
        expectedOpenai: ['OpenAI Third', 'OpenAI First', 'OpenAI Second'],
        expectedAnthropic: ['Anthropic First', 'Anthropic Second'],
      },
      {
        source: 'Anthropic First', target: 'Anthropic Second',
        expectedIds: ['openai-first', 'anthropic-second', 'openai-second', 'anthropic-first', 'openai-third'],
        expectedOpenai: ['OpenAI First', 'OpenAI Second', 'OpenAI Third'],
        expectedAnthropic: ['Anthropic Second', 'Anthropic First'],
      },
    ])('reorders $source onto $target without moving the other format', async testCase => {
      await renderProviders()
      switchProviderTab(testCase.source.startsWith('Anthropic') ? 'anthropic' : 'openai')
      const source = screen.getByRole('article', { name: testCase.source })
      const target = screen.getByRole('article', { name: testCase.target })
      fireEvent.dragStart(source)
      fireEvent.dragOver(target)
      fireEvent.drop(target)

      await waitFor(() => {
        expect(getMessages('REORDER_PROVIDERS')).toEqual([
          { type: 'REORDER_PROVIDERS', payload: testCase.expectedIds },
        ])
      })
      expect(getCardNames(switchProviderTab('openai'))).toEqual(testCase.expectedOpenai)
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(testCase.expectedAnthropic)
    })

    it('clears the drag state on tab changes and ignores drops in the other format', async () => {
      await renderProviders()
      const first = screen.getByRole('article', { name: 'OpenAI First' })
      fireEvent.dragStart(first)
      expect(first).toHaveClass('opacity-30')
      switchProviderTab('anthropic')
      fireEvent.dragOver(screen.getByRole('article', { name: 'Anthropic First' }))
      fireEvent.drop(screen.getByRole('article', { name: 'Anthropic First' }))
      switchProviderTab('openai')
      fireEvent.drop(screen.getByRole('article', { name: 'OpenAI Third' }))

      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
      expect(screen.getByRole('article', { name: 'OpenAI First' })).not.toHaveClass('opacity-30')
      expect(getCardNames(screen.getByRole('tabpanel'))).toEqual(['OpenAI First', 'OpenAI Second', 'OpenAI Third'])
      expect(getCardNames(switchProviderTab('anthropic'))).toEqual(['Anthropic First', 'Anthropic Second'])
    })

    it('ignores self drops and drops while selecting providers', async () => {
      await renderProviders()
      const first = screen.getByRole('article', { name: 'OpenAI First' })
      fireEvent.dragStart(first)
      fireEvent.drop(first)
      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: 'Select' }))
      fireEvent.dragStart(first)
      fireEvent.drop(screen.getByRole('article', { name: 'OpenAI Third' }))

      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
    })
  })

  describe('cross-tab drag copies and converts format', () => {
    it.each([
      { source: 'OpenAI Provider', sourceTab: 'openai' as const, sourceModel: 'gpt-4.1', tab: 'Anthropic', expectedFormat: 'anthropic', expectedApiType: 'messages' },
      { source: 'Anthropic Provider', sourceTab: 'anthropic' as const, sourceModel: 'claude-sonnet-4-5', tab: 'OpenAI', expectedFormat: 'openai', expectedApiType: 'both' },
      { source: 'OpenAI Provider', sourceTab: 'openai' as const, sourceModel: 'gpt-4.1', tab: 'DeepSeek', expectedFormat: 'deepseek', expectedApiType: 'all' },
    ] as const)('copies $source onto the $tab tab as $expectedApiType format', async testCase => {
      await renderProviders()
      switchProviderTab(testCase.sourceTab)
      fireEvent.dragStart(screen.getByRole('article', { name: testCase.source }))
      const tab = screen.getByRole('tab', { name: new RegExp(`^${testCase.tab}`) })
      fireEvent.dragOver(tab)
      expect(tab).toHaveClass('bg-emerald-50')
      fireEvent.drop(tab)

      await waitFor(() => expect(getMessages('ADD_PROVIDER')).toHaveLength(1))
      const payload = getMessages('ADD_PROVIDER')[0].payload
      expect(payload).toMatchObject({
        name: `${testCase.source} (${testCase.expectedFormat})`,
        format: testCase.expectedFormat,
        apiType: testCase.expectedApiType,
        isActive: false,
      })
      expect(payload.models).toEqual([
        { name: testCase.sourceModel, apiType: testCase.expectedApiType, format: testCase.expectedFormat },
      ])
      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
    })

    it('leaves the source provider unchanged and does not copy onto its own format tab', async () => {
      await renderProviders()
      fireEvent.dragStart(screen.getByRole('article', { name: 'OpenAI Provider' }))
      fireEvent.drop(screen.getByRole('tab', { name: /^OpenAI/ }))
      expect(getMessages('ADD_PROVIDER')).toHaveLength(0)
      expect(getMessages('REORDER_PROVIDERS')).toHaveLength(0)
      expect(storedProviders.find(provider => provider.id === 'openai')!.format).toBe('openai')
    })
  })
})
