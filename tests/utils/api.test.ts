import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testProviderConnection } from '../../src/utils/api'

global.fetch = vi.fn()

function mockFetchResponse(ok: boolean, status: number, body: unknown) {
  ;(fetch as any).mockResolvedValueOnce({
    ok,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('API Utility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
