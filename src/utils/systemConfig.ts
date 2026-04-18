import type { Provider } from '../types'

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
  
  const hasNativeHost =
    typeof chrome !== 'undefined' &&
    chrome?.runtime &&
    (
      typeof (chrome as any).runtime.sendNativeMessage === 'function' ||
      typeof (chrome as any).runtime.connectNative === 'function'
    )

  console.log('[CodexSwitch] hasNativeHost:', hasNativeHost)

  if (hasNativeHost) {
    try {
      if (typeof (chrome as any).runtime.sendNativeMessage === 'function') {
        console.log('[CodexSwitch] Sending config via sendNativeMessage:', config)
        return await new Promise((resolve) => {
          try {
            ;(chrome as any).runtime.sendNativeMessage('codex_config_host', config, (msg: any) => {
              const error = chrome.runtime.lastError
              if (error) {
                console.log('[CodexSwitch] Native host lastError:', error)
                resolve({ success: false, error: error.message || 'Disconnected' })
                return
              }

              console.log('[CodexSwitch] Native host response:', msg)
              resolve({ success: !!msg?.success, error: msg?.error })
            })
          } catch (err) {
            console.error('[CodexSwitch] Error:', err)
            resolve({ success: false, error: (err as Error).message })
          }
        })
      }

      return await new Promise((resolve) => {
        try {
          console.log('[CodexSwitch] Connecting to native host...')
          const port = (chrome as any).runtime.connectNative('codex_config_host')
          
          port.onMessage.addListener((msg: any) => {
            console.log('[CodexSwitch] Native host response:', msg)
            resolve({ success: !!msg?.success, error: msg?.error })
          })
          
          port.onDisconnect.addListener(() => {
            const error = chrome.runtime.lastError
            console.log('[CodexSwitch] Native host disconnected, lastError:', error)
            resolve({ success: false, error: error?.message || 'Disconnected' })
          })
          
          console.log('[CodexSwitch] Sending config:', config)
          port.postMessage(config)
        } catch (err) {
          console.error('[CodexSwitch] Error:', err)
          resolve({ success: false, error: (err as Error).message })
        }
      })
    } catch (err) {
      const e = err as Error
      console.error('[CodexSwitch] Outer error:', e)
      return { success: false, error: e.message }
    }
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
