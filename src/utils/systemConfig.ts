import type { Provider } from '../types'

function sendNativeMessage(config: object): Promise<{ success: boolean; error?: string }> {
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
          resolve({ success: !!msg?.success, error: msg?.error })
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
        resolve({ success: !!msg?.success, error: msg?.error })
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
