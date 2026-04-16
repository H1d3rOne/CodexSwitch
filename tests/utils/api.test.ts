import { describe, it, expect, vi } from 'vitest'
import { testProviderConnection } from '../../src/utils/api'

global.fetch = vi.fn()

describe('API Utility', () => {
  it('should return success for valid API response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Hello!' } }] }),
    })

    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(true)
    expect(result.message).toContain('Connection successful')
  })

  it('should return error for 401 response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    })

    const result = await testProviderConnection(
      'https://api.test.com',
      'invalid-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid API Key')
  })

  it('should return error for network failure', async () => {
    (fetch as any).mockRejectedValueOnce(new Error('Network error'))

    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Connection failed')
  })

  it('should return error for 403 response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    })

    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Insufficient quota')
  })

  it('should return error for 500 response', async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    })

    const result = await testProviderConnection(
      'https://api.test.com',
      'test-key'
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Server error')
  })
})
