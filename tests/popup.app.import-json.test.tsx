import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { App } from '../src/popup/App'

const sendMessageMock = vi.fn()
const storageGetMock = vi.fn()
const storageSetMock = vi.fn()

function installChromeMocks() {
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
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
        local: {
          get: storageGetMock,
          set: storageSetMock,
        },
      },
    },
  })
}

describe('App import JSON', () => {
  const alertMock = vi.fn()

  beforeEach(() => {
    sendMessageMock.mockReset()
    storageGetMock.mockReset()
    storageSetMock.mockReset()
    alertMock.mockReset()

    storageGetMock.mockResolvedValue({})
    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PROVIDERS') {
        return { success: true, data: [] }
      }
      if (message.type === 'GET_CHAT_SESSIONS') {
        return { success: true, data: { sessions: [], activeId: null } }
      }
      if (message.type === 'IMPORT_PROVIDERS') {
        return { success: false, error: 'Invalid or missing version' }
      }
      return { success: true }
    })

    installChromeMocks()

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    vi.stubGlobal('alert', alertMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces backend import validation errors instead of silently swallowing them', async () => {
    const { container } = render(<App />)
    const input = container.querySelector('input[type="file"][accept=".json"]') as HTMLInputElement | null
    if (!input) throw new Error('Import file input not found')

    const file = {
      name: 'providers.json',
      type: 'application/json',
      text: vi.fn(async () =>
        JSON.stringify({
          version: '2.0',
          providers: [],
        })
      ),
    } as unknown as File

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })

    fireEvent.change(input)

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'IMPORT_PROVIDERS',
          payload: { version: '2.0', providers: [] },
        })
      )
      expect(alertMock).toHaveBeenCalledWith('Invalid or missing version')
    })
  })
})
