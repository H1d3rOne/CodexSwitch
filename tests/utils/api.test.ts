import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamChat, testProviderConnection } from '../../src/utils/api'
import type { ChatMessage } from '../../src/types'

global.fetch = vi.fn()

function mockFetchResponse(ok: boolean, status: number, body: unknown) {
  ;(fetch as any).mockResolvedValueOnce({
    ok,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function mockStreamFetchResponse(ok: boolean, status: number, body: string, statusText = 'OK') {
  ;(fetch as any).mockResolvedValueOnce({
    ok,
    status,
    statusText,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
  })
}

async function collectStream(generator: AsyncGenerator<string, void, unknown>): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of generator) {
    chunks.push(chunk)
  }
  return chunks.join('')
}

describe('API Utility', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns success for a valid chat/completions test response', async () => {
    mockFetchResponse(true, 200, { choices: [{ message: { content: 'Hello!' } }] })

    const result = await testProviderConnection('https://api.test.com', 'test-key', 'gpt-test', 'chat')

    expect(fetch).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.message).toBe('All endpoints OK (chat)')
    expect(result.responseBody).toBeDefined()
  })

  it.each([401, 403, 500])('returns an HTTP %s failure for chat tests', async (status) => {
    mockFetchResponse(false, status, { error: `HTTP ${status}` })

    const result = await testProviderConnection('https://api.test.com', 'test-key', 'gpt-test', 'chat')

    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(status)
    expect(result.error).toBe(`chat: HTTP ${status}`)
  })

  it('sends Responses API input as a list, not a string', async () => {
    mockFetchResponse(true, 200, { id: 'resp_123', output_text: 'ok' })

    const result = await testProviderConnection('https://api.test.com/v1', 'test-key', 'gpt-test', 'responses')
    const requestBody = JSON.parse((fetch as any).mock.calls[0][1].body)

    expect(fetch).toHaveBeenCalledWith(
      'https://api.test.com/v1/responses',
      expect.objectContaining({ method: 'POST' })
    )
    expect(Array.isArray(requestBody.input)).toBe(true)
    expect(requestBody.input[0]).toMatchObject({ role: 'user', content: expect.any(String) })
    expect(result.success).toBe(true)
  })

  it('keeps HTTP 200 SSE-style responses green without requiring the whole body to be JSON', async () => {
    mockFetchResponse(true, 200, [
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"index":0}]}',
      '',
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_test","object":"response","status":"in_progress","error":null}}',
      '',
    ].join('\n'))

    const result = await testProviderConnection('https://api.test.com/v1', 'test-key', 'gpt-test', 'responses')

    expect(result).toMatchObject({
      success: true,
      statusCode: 200,
      message: 'All endpoints OK (responses)',
    })
  })

  it('returns error without statusCode for network failure', async () => {
    ;(fetch as any).mockRejectedValueOnce(new Error('Network error'))

    const result = await testProviderConnection('https://api.test.com', 'test-key', 'gpt-test', 'chat')
    expect(result.success).toBe(false)
    expect(result.statusCode).toBeUndefined()
    expect(result.message).toBe('Error')
  })

  it('continues API tests across DeepSeek protocols after a transport failure', async () => {
    ;(fetch as any).mockRejectedValueOnce(new Error('Chat socket closed'))
    mockFetchResponse(true, 200, { id: 'responses-test' })
    mockFetchResponse(true, 200, { id: 'messages-test' })

    const result = await testProviderConnection(
      'https://deepseek.example',
      'deepseek-key',
      'deepseek-chat',
      'all',
      'deepseek',
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain('responses OK')
    expect(result.message).toContain('chat failed (Chat socket closed)')
    expect((fetch as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'https://deepseek.example/v1/chat/completions',
      'https://deepseek.example/v1/responses',
      'https://deepseek.example/v1/messages',
    ])
    expect(result.endpoints).toEqual([
      expect.objectContaining({ label: 'chat', success: false, statusCode: 0, error: 'Chat socket closed' }),
      expect.objectContaining({ label: 'responses', success: true, statusCode: 200 }),
      expect.objectContaining({ label: 'messages', success: true, statusCode: 200 }),
    ])
  })

  it('streams OpenAI chat through chat/completions by default', async () => {
    mockStreamFetchResponse(true, 200, [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }]
    const content = await collectStream(streamChat('https://api.test.com', 'test-key', 'gpt-test', messages))
    const requestBody = JSON.parse((fetch as any).mock.calls[0][1].body)

    expect(fetch).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    expect(requestBody).toMatchObject({ model: 'gpt-test', messages, stream: true })
    expect(content).toBe('Hello')
  })

  it('streams OpenAI chat through chat/completions when apiType is both', async () => {
    mockStreamFetchResponse(true, 200, [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }]
    await collectStream(streamChat('https://api.test.com/v1', 'test-key', 'gpt-test', messages, 'both'))

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.test.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('tests all three DeepSeek protocols with stable endpoints and protocol-specific bodies', async () => {
    mockFetchResponse(true, 200, { id: 'chat-test' })
    mockFetchResponse(true, 200, { id: 'responses-test' })
    mockFetchResponse(true, 200, { id: 'messages-test' })

    const result = await testProviderConnection(
      'https://deepseek.example/v1/',
      'deepseek-key',
      'deepseek-chat',
      'all',
      'deepseek',
    )

    expect(result).toMatchObject({
      success: true,
      statusCode: 200,
      message: 'All endpoints OK (chat, responses, messages)',
    })
    expect((fetch as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'https://deepseek.example/v1/chat/completions',
      'https://deepseek.example/v1/responses',
      'https://deepseek.example/v1/messages',
    ])

    const [chatOptions, responsesOptions, messagesOptions] = (fetch as any).mock.calls.map((call: any[]) => call[1])
    expect(chatOptions.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(chatOptions.body)).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: expect.any(String) }],
      max_tokens: 5,
    })
    expect(JSON.parse(responsesOptions.body)).toMatchObject({
      model: 'deepseek-chat',
      input: [{ role: 'user', content: expect.any(String) }],
      max_output_tokens: 16,
    })
    expect(messagesOptions.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'x-api-key': 'deepseek-key',
      'anthropic-version': '2023-06-01',
    })
    expect(JSON.parse(messagesOptions.body)).toMatchObject({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: expect.any(String) }] }],
      max_tokens: 128,
    })
  })

  it('uses the DeepSeek Messages endpoint and Anthropic-compatible headers for an explicit messages test', async () => {
    mockFetchResponse(true, 200, { id: 'messages-test' })

    const result = await testProviderConnection(
      'https://deepseek.example',
      'deepseek-key',
      'deepseek-reasoner',
      'messages',
      'deepseek',
    )

    const [url, options] = (fetch as any).mock.calls[0]
    const body = JSON.parse(options.body)
    expect(url).toBe('https://deepseek.example/v1/messages')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'x-api-key': 'deepseek-key',
      'anthropic-version': '2023-06-01',
    })
    expect(body).toEqual({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: [{ type: 'text', text: expect.any(String) }] }],
      max_tokens: 128,
    })
    expect(result.success).toBe(true)
  })

  it('streams DeepSeek Chat, Responses, and Messages formats', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hi' },
    ]

    mockStreamFetchResponse(true, 200, [
      'data: {"choices":[{"delta":{"content":"chat"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
    expect(await collectStream(streamChat('https://deepseek.example', 'key', 'deepseek-chat', messages, 'chat', 'deepseek'))).toBe('chat')
    expect((fetch as any).mock.calls[0][0]).toBe('https://deepseek.example/v1/chat/completions')
    expect((fetch as any).mock.calls[0][1].headers.Authorization).toBe('Bearer key')

    mockStreamFetchResponse(true, 200, [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"responses"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
    expect(await collectStream(streamChat('https://deepseek.example/v1', 'key', 'deepseek-chat', messages, 'responses', 'deepseek'))).toBe('responses')
    expect((fetch as any).mock.calls[1][0]).toBe('https://deepseek.example/v1/responses')
    expect(JSON.parse((fetch as any).mock.calls[1][1].body)).toMatchObject({
      input: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hi' },
      ],
      stream: true,
    })

    mockStreamFetchResponse(true, 200, [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"messages"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
    expect(await collectStream(streamChat('https://deepseek.example', 'key', 'deepseek-chat', messages, 'messages', 'deepseek'))).toBe('messages')
    expect((fetch as any).mock.calls[2][0]).toBe('https://deepseek.example/v1/messages')
    expect((fetch as any).mock.calls[2][1].headers).toMatchObject({
      Authorization: 'Bearer key',
      'x-api-key': 'key',
      'anthropic-version': '2023-06-01',
    })
    expect(JSON.parse((fetch as any).mock.calls[2][1].body)).toMatchObject({
      system: 'Be concise',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      stream: true,
    })
  })

  it('parses SSE event names and multi-line data for Responses and Messages', async () => {
    mockStreamFetchResponse(true, 200, [
      'event: response.output_text.delta',
      'data: {"delta":',
      'data: "responses"}',
      '',
      'data: [DONE]',
      '',
    ].join('\r\n'))

    expect(await collectStream(streamChat(
      'https://deepseek.example',
      'key',
      'deepseek-chat',
      [{ role: 'user', content: 'Hi' }],
      'responses',
      'deepseek',
    ))).toBe('responses')

    mockStreamFetchResponse(true, 200, [
      'event: content_block_delta',
      'data: {"delta":{"text":',
      'data: "messages"}}',
      '',
      'data: [DONE]',
    ].join('\n'))

    expect(await collectStream(streamChat(
      'https://deepseek.example',
      'key',
      'deepseek-chat',
      [{ role: 'user', content: 'Hi' }],
      'messages',
      'deepseek',
    ))).toBe('messages')
  })

  it('falls back across all DeepSeek protocols only on failed requests', async () => {
    mockFetchResponse(false, 404, { error: { message: 'chat unavailable' } })
    mockFetchResponse(false, 404, { error: { message: 'responses unavailable' } })
    mockStreamFetchResponse(true, 200, [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"messages fallback"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))

    const content = await collectStream(streamChat(
      'https://deepseek.example',
      'key',
      'deepseek-chat',
      [{ role: 'user', content: 'Hi' }],
      'all',
      'deepseek',
    ))

    expect(content).toBe('messages fallback')
    expect((fetch as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'https://deepseek.example/v1/chat/completions',
      'https://deepseek.example/v1/responses',
      'https://deepseek.example/v1/messages',
    ])
  })

  it('does not retry another DeepSeek protocol after an accepted HTTP 200 stream', async () => {
    mockStreamFetchResponse(true, 200, 'event: response.created\ndata: {"type":"response.created"}\n\n')
    mockStreamFetchResponse(true, 200, 'data: {"choices":[{"delta":{"content":"must not retry"}}]}\n\n')

    const content = await collectStream(streamChat(
      'https://deepseek.example',
      'key',
      'deepseek-chat',
      [{ role: 'user', content: 'Hi' }],
      'all',
      'deepseek',
    ))

    expect(content).toBe('')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to Responses when a both provider rejects Chat and converts the stream back', async () => {
    mockFetchResponse(false, 404, { error: { message: 'chat endpoint not found' } })
    mockStreamFetchResponse(true, 200, [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"response fallback"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_fallback","object":"response","status":"completed","output":[]}}',
      '',
    ].join('\n'))

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }]
    const content = await collectStream(streamChat('https://api.test.com', 'test-key', 'gpt-test', messages, 'both'))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect((fetch as any).mock.calls.map((call: any[]) => call[0])).toEqual([
      'https://api.test.com/v1/chat/completions',
      'https://api.test.com/v1/responses',
    ])
    expect(content).toBe('response fallback')
  })
})
