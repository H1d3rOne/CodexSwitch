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

function openModelTestForm(container: HTMLElement) {
  const addProviderButton = container.querySelectorAll('button')[1]
  fireEvent.click(addProviderButton)
  fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
    target: { value: 'https://api.example.com' },
  })
  const modelInput = screen.getByPlaceholderText('Add model...')
  fireEvent.change(modelInput, { target: { value: 'gpt-4o-mini' } })
  const addModelButton = modelInput.parentElement?.querySelector('button')
  if (!addModelButton) throw new Error('Add model button not found')
  fireEvent.click(addModelButton)
  return addProviderButton
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
            responseBody: '{"id":"resp_123","ok":true}',
          },
        }
      }
      if (message.type === 'TEST_MODEL_VIA_ROUTER') {
        return {
          success: true,
          data: {
            success: true,
            statusCode: 200,
            message: 'responses: OK via Chat',
            endpoints: [{
              label: 'responses',
              success: true,
              statusCode: 200,
              convertedFrom: 'chat',
              nativeStatusCode: 404,
              nativeError: 'responses unsupported',
              nativeResponseBody: '{"error":{"message":"responses unsupported"}}',
              responseBody: '{"object":"response","output":[]}',
            }],
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

  it('fills /v1 into the baseUrl input and displays the retried test result without auto-saving', async () => {
    const { container } = render(<App />)
    expect(screen.getByRole('switch', { name: 'Model test routing' })).not.toBeChecked()

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

    const addModelInput = screen.getByPlaceholderText('Add model...')
    const addModelButton = addModelInput.parentElement?.querySelector('button') as HTMLButtonElement | null
    if (!addModelButton) throw new Error('Add model button not found')
    fireEvent.click(addModelButton)

    fireEvent.click(screen.getByText('Test'))

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://api.example.com/v1')).toBeInTheDocument()
    })

    expect(screen.getByText('200')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
    expect(screen.getByText('{"id":"resp_123","ok":true}')).toBeInTheDocument()

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'TEST_PROVIDER',
        payload: expect.objectContaining({ baseUrl: 'https://api.example.com' }),
      })
    )
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ADD_PROVIDER' }))
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_PROVIDER' }))
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TEST_MODEL_VIA_ROUTER' }))
  })

  it('routes only the form model test and separates the final response from collapsed native diagnostics', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(<App />)
    openModelTestForm(container)
    fireEvent.click(screen.getByRole('switch', { name: 'Model test routing' }))
    fireEvent.click(screen.getByText('Test'))

    const conversionLabel = await screen.findByText('OK via Chat (native 404)')
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TEST_MODEL_VIA_ROUTER',
      payload: expect.objectContaining({ id: 'temp', baseUrl: 'https://api.example.com', model: 'gpt-4o-mini', apiType: 'both', format: 'openai' }),
    }))
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TEST_PROVIDER' }))
    for (const type of ['ENABLE_ROUTER', 'DISABLE_ROUTER', 'UPDATE_ROUTER_SETTINGS', 'SET_ACTIVE_PROVIDER', 'ADD_PROVIDER', 'UPDATE_PROVIDER']) {
      expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type }))
    }
    fireEvent.click(conversionLabel.closest('button')!)
    const nativeDiagnostics = screen.getByText('Native responses diagnostics (404)').closest('details')!
    expect(nativeDiagnostics.open).toBe(false)
    expect(screen.getByText('Final responses response')).toBeInTheDocument()
    expect(screen.getByText('{"error":{"message":"responses unsupported"}}')).toBeInTheDocument()
    expect(screen.getByText('{"object":"response","output":[]}')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy final responses response' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"object":"response","output":[]}'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Diagnostics only; not sent to clients.')).toBeInTheDocument()
  })

  it('clears routed results and resumes browser-direct tests when switched off', async () => {
    const { container } = render(<App />)
    openModelTestForm(container)
    const routingSwitch = screen.getByRole('switch', { name: 'Model test routing' })
    fireEvent.click(routingSwitch)
    fireEvent.click(screen.getByText('Test'))
    await screen.findByText('OK via Chat (native 404)')

    fireEvent.click(routingSwitch)
    expect(routingSwitch).not.toBeChecked()
    expect(screen.queryByText('OK via Chat (native 404)')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Test'))
    await screen.findByDisplayValue('https://api.example.com/v1')
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'TEST_PROVIDER' }))
  })

  it('resets model-test routing when a new provider form opens', async () => {
    const { container } = render(<App />)
    const addProviderButton = openModelTestForm(container)
    const routingSwitch = screen.getByRole('switch', { name: 'Model test routing' })
    fireEvent.click(routingSwitch)
    expect(routingSwitch).toBeChecked()
    fireEvent.click(addProviderButton)
    await waitFor(() => expect(routingSwitch).not.toBeChecked())
  })

  it('shows a Native Host failure instead of silently falling back to browser requests', async () => {
    const defaultHandler = sendMessageMock.getMockImplementation()!
    sendMessageMock.mockImplementation((message: { type: string }) => message.type === 'TEST_MODEL_VIA_ROUTER'
      ? Promise.resolve({ success: false, error: 'Native messaging host not found' })
      : defaultHandler(message))
    const { container } = render(<App />)
    openModelTestForm(container)
    fireEvent.click(screen.getByRole('switch', { name: 'Model test routing' }))
    fireEvent.click(screen.getByText('Test'))
    expect(await screen.findByText('Native messaging host not found')).toBeInTheDocument()
    expect(sendMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TEST_PROVIDER' }))
  })

  it('disables the model-test switch while a routed test is pending', async () => {
    let completeTest: (value: unknown) => void = () => {}
    const pendingTest = new Promise(resolve => { completeTest = resolve })
    const defaultHandler = sendMessageMock.getMockImplementation()!
    sendMessageMock.mockImplementation((message: { type: string }) => message.type === 'TEST_MODEL_VIA_ROUTER'
      ? pendingTest
      : defaultHandler(message))
    const { container } = render(<App />)
    openModelTestForm(container)
    const routingSwitch = screen.getByRole('switch', { name: 'Model test routing' })
    fireEvent.click(routingSwitch)
    fireEvent.click(screen.getByText('Test'))
    expect(routingSwitch).toBeDisabled()
    completeTest({ success: true, data: { success: true, statusCode: 200, message: 'OK' } })
    await waitFor(() => expect(routingSwitch).toBeEnabled())
  })
})
