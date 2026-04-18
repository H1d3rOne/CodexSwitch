import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { updateCodexSystemForProvider } from '../src/utils/systemConfig'

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
