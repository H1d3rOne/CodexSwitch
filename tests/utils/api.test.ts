import { describe, it, expect, vi, beforeEach } from 'vitest'
import { testProviderConnection } from '../../src/utils/api'

global.fetch = vi.fn()

describe('API Utility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('should return success with statusCode 200', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'Hello!' } }] }),
    })

    const result = await testProviderConnection('https://api.test.com', 'test-key')
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.message).toBe('200')
    expect(result.responseBody).toBeDefined()
  })

  it('should return error with statusCode 401', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"error":"Unauthorized"}',
    })

    const result = await testProviderConnection('https://api.test.com', 'invalid-key')
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(401)
  })

  it('should return error with statusCode 403', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"error":"Forbidden"}',
    })

    const result = await testProviderConnection('https://api.test.com', 'test-key')
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(403)
  })

  it('should return error with statusCode 500', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => '{"error":"Internal Server Error"}',
    })

    const result = await testProviderConnection('https://api.test.com', 'test-key')
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(500)
  })



  it('should retry with /v1 and return correctedBaseUrl when first 200 response is not valid JSON', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html>ok</html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'Hello from v1!' } }] }),
      })

    const result = await testProviderConnection('https://api.test.com', 'test-key')

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.test.com/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api.test.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result).toMatchObject({
      success: true,
      statusCode: 200,
      correctedBaseUrl: 'https://api.test.com/v1',
    })
  })

  it('should return error without statusCode for network failure', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('Network error'))

    const result = await testProviderConnection('https://api.test.com', 'test-key')
    expect(result.success).toBe(false)
    expect(result.statusCode).toBeUndefined()
    expect(result.message).toBe('Error')
  })
})
