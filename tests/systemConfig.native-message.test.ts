import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableLocalRouter, testModelViaRouter, updateCodexSystemForProvider, updateLocalRouterProvider, setClientRouting, updateDeepSeekHarnessConfig, updateRouterClientDisguise } from '../src/utils/systemConfig'
import { buildRouterIdentityMap, buildRouterDisguiseMap, DEFAULT_CLIENT_IDENTITY } from '../src/utils/clientIdentity'

// Auto uses the native client fingerprint for each wire format.
const routerIdentityFor = (format: 'openai' | 'anthropic') => buildRouterIdentityMap(DEFAULT_CLIENT_IDENTITY)[format]!

const provider = {
  id: 'p1',
  name: 'Test Provider',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4.1',
  models: ['gpt-4.1'],
  isActive: true,
  createdAt: 0,
  updatedAt: 0,
}

describe('updateCodexSystemForProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete (globalThis as any).chrome
  })

  it('prefers sendNativeMessage for one-shot native host sync requests', async () => {
    const sendNativeMessage = vi.fn((hostName: string, message: unknown, callback: (response: unknown) => void) => {
      callback({ success: true })
    })
    const connectNative = vi.fn(() => {
      throw new Error('connectNative should not be used when sendNativeMessage is available')
    })

    ;(globalThis as any).chrome = {
      runtime: {
        sendNativeMessage,
        connectNative,
        lastError: undefined,
      },
    }

    const result = await updateCodexSystemForProvider(provider as any)

    expect(result).toEqual({ success: true, error: undefined })
    expect(sendNativeMessage).toHaveBeenCalledTimes(1)
    expect(sendNativeMessage).toHaveBeenCalledWith(
      'codex_config_host',
      {
        action: 'updateConfig',
        config: {
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
        },
      },
      expect.any(Function)
    )
    expect(connectNative).not.toHaveBeenCalled()
  })
})

describe('updateDeepSeekHarnessConfig', () => {
  afterEach(() => {
    delete (globalThis as any).chrome
  })

  it.each([
    ['chat', 'openai-completions'],
    ['responses', 'openai-responses'],
    ['messages', 'anthropic-messages'],
  ] as const)('writes only the selected model and maps %s to %s', async (selectedApiType, expectedApi) => {
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage, lastError: undefined } }
    const deepseek = {
      ...provider,
      format: 'deepseek' as const,
      apiType: 'all' as const,
      selectedApiType,
      model: 'selected-model',
      models: [
        { name: 'selected-model', apiType: 'all' as const },
        { name: 'other-model-a', apiType: 'all' as const },
        { name: 'other-model-b', apiType: 'all' as const },
      ],
    }

    expect((await updateDeepSeekHarnessConfig(deepseek as any)).success).toBe(true)
    expect(sendNativeMessage).toHaveBeenCalledTimes(1)
    expect(sendNativeMessage.mock.calls[0][1]).toEqual({
      action: 'updateDeepSeekHarnessConfig',
      config: {
        providerId: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: 'selected-model',
        api: expectedApi,
        models: [{ id: 'selected-model' }],
      },
    })
  })
})

describe('client disguise Native Host bridge', () => {
  afterEach(() => { delete (globalThis as any).chrome })

  it('sends the entry-client disguise map to the Router via setClientDisguise', async () => {
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage } }
    const disguise = { openai: { preset: 'claude-code' as const }, deepseek: { preset: 'codex' as const } }
    expect(await updateRouterClientDisguise(disguise)).toEqual({ success: true })
    expect(sendNativeMessage).toHaveBeenCalledWith('codex_config_host', {
      action: 'setClientDisguise',
      config: { clientDisguise: buildRouterDisguiseMap(disguise) },
    }, expect.any(Function))
  })

  it('reads the saved disguise when no argument is given', async () => {
    const saved = { anthropic: { preset: 'deepseek-harness' } }
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true }))
    ;(globalThis as any).chrome = {
      runtime: { sendNativeMessage },
      storage: { local: { get: vi.fn(async () => ({ client_disguise: saved })) } },
    }
    await updateRouterClientDisguise()
    expect(sendNativeMessage.mock.calls[0][1]).toMatchObject({ config: { clientDisguise: buildRouterDisguiseMap(saved) } })
  })
})

describe('model-test Native Host bridge', () => {
  it('uses saved per-format identities for startup, provider changes, routing changes and model tests', async () => {
    const settings = { default: { preset: 'codex' as const, version: '1.2.3' }, formatIdentities: { anthropic: { preset: 'off' as const } } }
    const identities = buildRouterIdentityMap(settings)
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage }, storage: { local: { get: vi.fn(async () => ({ client_identity: settings })) } } }
    const anthropic = { ...provider, format: 'anthropic' as const }
    await enableLocalRouter(provider as any, 15721, '', { anthropic: anthropic as any })
    expect(sendNativeMessage.mock.calls[0][1]).toMatchObject({ action: 'enableRouter', config: { clientIdentity: identities, provider: { clientIdentity: identities.openai }, providers: { anthropic: { clientIdentity: identities.anthropic } } } })
    await updateLocalRouterProvider(anthropic as any, 'anthropic')
    await testModelViaRouter(anthropic as any)
    await setClientRouting('anthropic', true, anthropic as any)
    for (const [, message] of sendNativeMessage.mock.calls.slice(1)) expect(message).toMatchObject({ config: { provider: { clientIdentity: identities.anthropic } } })
  })

  afterEach(() => {
    delete (globalThis as any).chrome
  })

  it('sends the form provider and selected model API type without enabling the global router', async () => {
    const data = { success: true, statusCode: 200, message: 'responses: OK via Chat' }
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true, data }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage, lastError: undefined } }
    const testProvider = { ...provider, groupApiKeys: {}, groupModels: {}, activeGroup: 'default', apiType: 'chat' as const, format: 'openai' as const, models: [{ name: provider.model, apiType: 'responses' as const }] }

    expect(await testModelViaRouter(testProvider, 'http://127.0.0.1:7890')).toEqual({ success: true, error: undefined, data })
    expect(sendNativeMessage).toHaveBeenCalledTimes(1)
    expect(sendNativeMessage).toHaveBeenCalledWith('codex_config_host', {
      action: 'testModelViaRouter',
      config: {
        provider: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, format: 'openai', apiType: 'responses', formatConversionEnabled: false, clientIdentity: routerIdentityFor('openai') },
        proxyUrl: 'http://127.0.0.1:7890',
      },
    }, expect.any(Function))
  })

  it('reports a missing Native Host without storing a fallback configuration', async () => {
    const storageSet = vi.fn()
    ;(globalThis as any).chrome = { runtime: {}, storage: { local: { set: storageSet } } }
    const testProvider = { ...provider, groupApiKeys: {}, groupModels: {}, activeGroup: 'default', models: [], apiType: 'chat' as const, format: 'openai' as const }

    expect(await testModelViaRouter(testProvider)).toEqual({ success: false, error: 'Native messaging not available' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it.each([
    { sourceFormat: 'openai', targetFormat: 'anthropic', labels: ['messages'] },
    { sourceFormat: 'anthropic', targetFormat: 'openai', labels: ['chat', 'responses'] },
  ] as const)('preserves native $sourceFormat settings while requesting converted $targetFormat tests', async ({ sourceFormat, targetFormat, labels }) => {
    const data = { success: true, message: 'OK', endpoints: labels.map(label => ({ label, success: true, statusCode: 200 })) }
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true, data }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage, lastError: undefined } }
    const testProvider = { ...provider, groupApiKeys: {}, groupModels: {}, activeGroup: 'default', models: [], apiType: 'chat' as const, format: sourceFormat, formatConversionEnabled: true }

    expect(await testModelViaRouter(testProvider, '', targetFormat)).toEqual({ success: true, error: undefined, data })
    expect(sendNativeMessage).toHaveBeenCalledWith('codex_config_host', {
      action: 'testModelViaRouter',
      config: {
        provider: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, format: sourceFormat, apiType: 'chat', formatConversionEnabled: true, clientIdentity: routerIdentityFor(sourceFormat) },
        proxyUrl: '', targetFormat,
      },
    }, expect.any(Function))
  })

  it.each([
    { targetFormat: 'anthropic', endpoints: [{ label: 'chat' }] },
    { targetFormat: 'openai', endpoints: [{ label: 'messages' }] },
    { targetFormat: 'openai', endpoints: [{ label: 'chat' }] },
    { targetFormat: 'anthropic', endpoints: undefined },
  ] as const)('rejects stale Native Host results instead of displaying native endpoints for $targetFormat', async ({ targetFormat, endpoints }) => {
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true, data: { success: true, message: 'OK', endpoints } }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage, lastError: undefined } }
    const testProvider = { ...provider, groupApiKeys: {}, groupModels: {}, activeGroup: 'default', models: [], apiType: 'chat' as const, format: 'openai' as const }

    const result = await testModelViaRouter(testProvider, '', targetFormat)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Update or reinstall the Native Host')
    expect(result.data).toBeUndefined()
  })
})

describe('provider format conversion Native Host bridge', () => {
  afterEach(() => {
    delete (globalThis as any).chrome
  })

  it.each([undefined, false, true])('sends normalized conversion state %s when enabling and updating the router', async formatConversionEnabled => {
    const sendNativeMessage = vi.fn((_host: string, _message: unknown, callback: (response: unknown) => void) => callback({ success: true }))
    ;(globalThis as any).chrome = { runtime: { sendNativeMessage, lastError: undefined } }
    const routerProvider = {
      ...provider,
      groupApiKeys: {},
      groupModels: {},
      activeGroup: 'default',
      format: 'openai' as const,
      apiType: 'both' as const,
      models: [{ name: provider.model, apiType: 'chat' as const }],
      formatConversionEnabled,
    }
    const expectedProvider = {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      format: 'openai',
      apiType: 'chat',
      formatConversionEnabled: formatConversionEnabled === true,
      clientIdentity: routerIdentityFor('openai'),
    }

    expect((await enableLocalRouter(routerProvider, 15721)).success).toBe(true)
    expect((await updateLocalRouterProvider(routerProvider)).success).toBe(true)
    expect(sendNativeMessage).toHaveBeenNthCalledWith(1, 'codex_config_host', {
      action: 'enableRouter',
      config: { port: 15721, proxyUrl: '', provider: expectedProvider, clientIdentity: buildRouterIdentityMap(DEFAULT_CLIENT_IDENTITY), clientDisguise: {} },
    }, expect.any(Function))
    expect(sendNativeMessage).toHaveBeenNthCalledWith(2, 'codex_config_host', {
      action: 'setRouterProvider',
      config: { provider: expectedProvider },
    }, expect.any(Function))
  })
})
