import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { App } from '../src/popup/App'
import type { ExportData } from '../src/types'

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

describe('App export JSON', () => {
  const exportPayload: ExportData = {
    version: '1.0',
    exportedAt: '2026-04-19T00:00:00.000Z',
    providers: [
      {
        name: 'Provider 1',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
        models: ['gpt-4.1'],
      },
    ],
  }

  let blobFromExport: { parts: unknown[]; type: string } | null = null
  let anchorClickMock: ReturnType<typeof vi.fn>
  const RealBlob = globalThis.Blob

  beforeEach(() => {
    sendMessageMock.mockReset()
    storageGetMock.mockReset()
    storageSetMock.mockReset()
    blobFromExport = null

    storageGetMock.mockResolvedValue({})
    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PROVIDERS') {
        return {
          success: true,
          data: [
            {
              id: 'p1',
              name: 'Provider 1',
              baseUrl: 'https://api.example.com/v1',
              apiKey: 'sk-test',
              model: 'gpt-4.1',
              models: ['gpt-4.1'],
              isActive: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }
      }
      if (message.type === 'GET_CHAT_SESSIONS') {
        return { success: true, data: { sessions: [], activeId: null } }
      }
      if (message.type === 'EXPORT_PROVIDERS') {
        return { success: true, data: exportPayload }
      }
      return { success: true }
    })

    installChromeMocks()

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    anchorClickMock = vi.fn()
    Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: anchorClickMock,
    })

    vi.stubGlobal('Blob', class MockBlob {
      parts: unknown[]
      type: string

      constructor(parts: unknown[], options?: { type?: string }) {
        this.parts = parts
        this.type = options?.type || ''
      }
    })

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        blobFromExport = blob as unknown as { parts: unknown[]; type: string }
        return 'blob:mock-url'
      }),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.Blob = RealBlob
  })

  it('exports a JSON file with serialized provider data instead of [object Object]', async () => {
    render(<App />)

    const exportButton = await screen.findByText('Export')
    fireEvent.click(exportButton)

    await waitFor(() => {
      expect(anchorClickMock).toHaveBeenCalledTimes(1)
      expect(blobFromExport).not.toBeNull()
    })

    const text = String(blobFromExport!.parts[0])
    expect(text).toContain('"version": "1.0"')
    expect(text).toContain('"name": "Provider 1"')
    expect(text).not.toBe('[object Object]')
  })
})
