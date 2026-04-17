import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('App form baseUrl correction', () => {
  beforeEach(() => {
    sendMessageMock.mockReset()
    storageGetMock.mockReset()
    storageSetMock.mockReset()

    storageGetMock.mockResolvedValue({})
    sendMessageMock.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PROVIDERS') {
        return { success: true, data: [] }
      }
      if (message.type === 'GET_CHAT_SESSIONS') {
        return { success: true, data: { sessions: [], activeId: null } }
      }
      if (message.type === 'TEST_PROVIDER') {
        return {
          success: true,
          data: {
            success: true,
            statusCode: 200,
            message: '200',
            correctedBaseUrl: 'https://api.example.com/v1',
            responseBody: '{"ok":true}',
          },
        }
      }
      return { success: true }
    })

    installChromeMocks()

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })



  it('shows full Import and Export labels in the footer after removing proxy_url field', async () => {
    render(<App />)

    expect(await screen.findByText('Import')).toBeInTheDocument()
    expect(screen.getByText('Export')).toBeInTheDocument()
    expect(screen.queryByText('I')).not.toBeInTheDocument()
    expect(screen.queryByText('E')).not.toBeInTheDocument()
  })

  it('fills /v1 into the baseUrl input after test succeeds with correctedBaseUrl without auto-saving', async () => {
    const { container } = render(<App />)

    const initialButtons = container.querySelectorAll('button')
    fireEvent.click(initialButtons[1])

    fireEvent.change(screen.getByPlaceholderText('OpenAI'), {
      target: { value: 'Example' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'https://api.example.com' },
    })
    fireEvent.change(screen.getByPlaceholderText('Add model...'), {
      target: { value: 'gpt-4o-mini' },
    })

    const buttonsAfterOpen = Array.from(container.querySelectorAll('button'))
    const addModelButton = buttonsAfterOpen.find(btn => btn.getAttribute('type') === 'button' && btn.textContent?.trim() === '')
    fireEvent.click(addModelButton!)

    fireEvent.click(screen.getByText('Test'))

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://api.example.com/v1')).toBeInTheDocument()
    })

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TEST_PROVIDER',
        payload: expect.objectContaining({ baseUrl: 'https://api.example.com' }),
      })
    )
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_PROVIDER' }))
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_PROVIDER' }))
  })
})
