import type { ApiType, Provider, ProviderFormat, TestResult } from '../types'
import { buildRouterDisguiseMap, buildRouterIdentityMap, getClientDisguiseSettings, getClientIdentitySettings, type ClientDisguiseSettings, type ClientIdentitySettings } from './clientIdentity'
import { selectedProtocol } from './modelFormat'

export interface RouterStatus {
  enabled: boolean
  running: boolean
  port?: number
  proxyUrl?: string
  provider?: string
  pid?: number
  clients?: Partial<Record<ProviderFormat, boolean>>
}

function defaultApiTypeForProvider(provider: Pick<Provider, 'format' | 'apiType'>): ApiType {
  if (provider.apiType) return provider.apiType
  if (provider.format === 'anthropic') return 'messages'
  if (provider.format === 'deepseek') return 'all'
  return 'both'
}

function deepSeekProtocolsForApiType(apiType: ApiType): string[] {
  if (apiType === 'chat') return ['openai-completions']
  if (apiType === 'responses') return ['openai-responses']
  if (apiType === 'messages') return ['anthropic-messages']
  if (apiType === 'both') return ['openai-completions', 'openai-responses']
  return ['openai-completions', 'openai-responses', 'anthropic-messages']
}

export function deepSeekProtocolForApiType(apiType: ApiType): string {
  return deepSeekProtocolsForApiType(apiType)[0]
}

function sendNativeMessage(config: object): Promise<{ success: boolean; error?: string; data?: unknown }> {
  const hasNativeHost =
    typeof chrome !== 'undefined' &&
    chrome?.runtime &&
    (
      typeof (chrome as any).runtime.sendNativeMessage === 'function' ||
      typeof (chrome as any).runtime.connectNative === 'function'
    )

  if (!hasNativeHost) {
    return Promise.resolve({ success: false, error: 'Native messaging not available' })
  }

  if (typeof (chrome as any).runtime.sendNativeMessage === 'function') {
    return new Promise((resolve) => {
      try {
        ;(chrome as any).runtime.sendNativeMessage('codex_config_host', config, (msg: any) => {
          const error = chrome.runtime.lastError
          if (error) {
            resolve({ success: false, error: error.message || 'Disconnected' })
            return
          }
          resolve({ success: !!msg?.success, error: msg?.error, data: msg?.data })
        })
      } catch (err) {
        resolve({ success: false, error: (err as Error).message })
      }
    })
  }

  return new Promise((resolve) => {
    try {
      const port = (chrome as any).runtime.connectNative('codex_config_host')
      port.onMessage.addListener((msg: any) => {
        resolve({ success: !!msg?.success, error: msg?.error, data: msg?.data })
      })
      port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError
        resolve({ success: false, error: error?.message || 'Disconnected' })
      })
      port.postMessage(config)
    } catch (err) {
      resolve({ success: false, error: (err as Error).message })
    }
  })
}

export async function updateCodexSystemForProvider(provider: Provider): Promise<{ success: boolean; error?: string }> {
  console.log('[CodexSwitch] updateCodexSystemForProvider called with:', provider.name)

  const config = {
    action: 'updateConfig',
    config: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model
    }
  }

  const result = await sendNativeMessage(config)
  if (result.success || result.error !== 'Native messaging not available') {
    return result
  }

  console.log('[CodexSwitch] Native messaging not available, using fallback')
  try {
    const cfg = {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
    }
    await (chrome as any).storage.local.set({ codex_config_sync: cfg })
    return { success: true }
  } catch (err) {
    const e = err as Error
    return { success: false, error: e.message }
  }
}

export async function updateDeepSeekHarnessConfig(provider: Provider): Promise<{ success: boolean; error?: string }> {
  console.log('[CodexSwitch] updateDeepSeekHarnessConfig called with:', provider.name)

  // Harness keeps a single managed provider entry in the profile patch file.
  // It exposes only the finally selected model (not the whole provider list);
  // api is the protocol mapped from that model's type: chat -> openai-completions,
  // responses -> openai-responses, messages -> anthropic-messages.
  const api = deepSeekProtocolForApiType(selectedProtocol(provider))
  const config = {
    action: 'updateDeepSeekHarnessConfig',
    config: {
      providerId: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      api,
      models: [{ id: provider.model }],
    },
  }

  const result = await sendNativeMessage(config)
  if (result.success || result.error !== 'Native messaging not available') {
    return result
  }

  console.log('[CodexSwitch] Native messaging not available, using fallback')
  try {
    await (chrome as any).storage.local.set({
      deepseek_harness_config_sync: config.config,
    })
    return { success: true }
  } catch (err) {
    const e = err as Error
    return { success: false, error: e.message }
  }
}

export async function updateClaudeSettingsForProvider(provider: Provider): Promise<{ success: boolean; error?: string }> {
  console.log('[CodexSwitch] updateClaudeSettingsForProvider called with:', provider.name)

  let baseUrl = provider.baseUrl.replace(/\/+$/, '')
  if (baseUrl.endsWith('/v1')) {
    baseUrl = baseUrl.slice(0, -3)
  }

  const config = {
    action: 'updateClaudeConfig',
    config: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
      model: provider.model,
    }
  }

  const result = await sendNativeMessage(config)
  if (result.success || result.error !== 'Native messaging not available') {
    return result
  }

  console.log('[CodexSwitch] Native messaging not available, using fallback')
  try {
    const cfg = {
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_AUTH_TOKEN: provider.apiKey,
      model: provider.model,
    }
    await (chrome as any).storage.local.set({ claude_config_sync: cfg })
    return { success: true }
  } catch (err) {
    const e = err as Error
    return { success: false, error: e.message }
  }
}

function toRouterProvider(provider: Provider, identity: ClientIdentitySettings) {
  const modelApiType = provider.models?.find(model => model.name === provider.model)?.apiType
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    format: provider.format || 'openai',
    apiType: modelApiType || defaultApiTypeForProvider(provider),
    formatConversionEnabled: provider.formatConversionEnabled === true,
    clientIdentity: buildRouterIdentityMap(identity)[provider.format || 'openai'],
  }
}

/** Persists the per-format identity on the Router so forwarded requests carry it too. */
export async function updateRouterClientIdentity(identity?: ClientIdentitySettings): Promise<{ success: boolean; error?: string }> {
  return sendNativeMessage({ action: 'setClientIdentity', config: { clientIdentity: buildRouterIdentityMap(identity || await getClientIdentitySettings()) } }) as Promise<{ success: boolean; error?: string }>
}

/** Persists the per-entry-client disguise on the Router so forwarded requests carry it after conversion. */
export async function updateRouterClientDisguise(disguise?: ClientDisguiseSettings): Promise<{ success: boolean; error?: string }> {
  return sendNativeMessage({ action: 'setClientDisguise', config: { clientDisguise: buildRouterDisguiseMap(disguise || await getClientDisguiseSettings()) } }) as Promise<{ success: boolean; error?: string }>
}

export async function getRouterStatus(): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  return sendNativeMessage({ action: 'routerStatus' }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}

export async function testModelViaRouter(provider: Provider, proxyUrl = '', targetFormat?: ProviderFormat): Promise<{ success: boolean; data?: TestResult; error?: string }> {
  const identity = await getClientIdentitySettings()
  const result = await sendNativeMessage({ action: 'testModelViaRouter', config: { provider: toRouterProvider(provider, identity), proxyUrl, ...(targetFormat ? { targetFormat } : {}) } }) as { success: boolean; data?: TestResult; error?: string }
  if (result.success && targetFormat) {
    const expectedEndpoints = targetFormat === 'anthropic' ? ['messages'] : targetFormat === 'deepseek' ? ['chat', 'responses', 'messages'] : ['chat', 'responses']
    const endpoints = result.data?.endpoints
    if (!endpoints || endpoints.length !== expectedEndpoints.length || !expectedEndpoints.every(label => endpoints.some(endpoint => endpoint.label === label))) {
      return { success: false, error: 'Native Host did not test the requested Router format. Update or reinstall the Native Host, then retry.' }
    }
  }
  return result
}

export async function enableLocalRouter(provider: Provider | undefined, port: number, proxyUrl = '', providers?: Partial<Record<ProviderFormat, Provider>>): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  const identity = await getClientIdentitySettings()
  const disguise = await getClientDisguiseSettings()
  return sendNativeMessage({ action: 'enableRouter', config: {
    ...(provider ? { provider: toRouterProvider(provider, identity) } : {}), port, proxyUrl,
    clientIdentity: buildRouterIdentityMap(identity),
    clientDisguise: buildRouterDisguiseMap(disguise),
    ...(providers ? { providers: Object.fromEntries(Object.entries(providers).map(([format, upstream]) => [format, toRouterProvider(upstream, identity)])) } : {}),
  } }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}

export async function updateLocalRouterProvider(provider: Provider, targetFormat?: ProviderFormat): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  const identity = await getClientIdentitySettings()
  return sendNativeMessage({ action: 'setRouterProvider', config: { provider: toRouterProvider(provider, identity), ...(targetFormat ? { targetFormat } : {}) } }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}

export async function updateLocalRouterSettings(port: number, proxyUrl: string): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  return sendNativeMessage({ action: 'updateRouterSettings', config: { port, proxyUrl } }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}

export async function setClientRouting(format: ProviderFormat, enabled: boolean, provider: Provider): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  const identity = await getClientIdentitySettings()
  return sendNativeMessage({ action: 'setClientRouting', config: { format, enabled, provider: { ...toRouterProvider(provider, identity), selectedApiType: selectedProtocol(provider) } } }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}

export async function disableLocalRouter(): Promise<{ success: boolean; data?: RouterStatus; error?: string }> {
  return sendNativeMessage({ action: 'disableRouter' }) as Promise<{ success: boolean; data?: RouterStatus; error?: string }>
}
