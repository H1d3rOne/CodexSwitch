import type { TestResult } from '../types'

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string = 'gpt-3.5-turbo'
): Promise<TestResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const url = baseUrl.endsWith('/')
      ? `${baseUrl}v1/chat/completions`
      : `${baseUrl}/v1/chat/completions`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      return { success: false, statusCode: response.status, message: `${response.status}`, error: `${response.status} ${response.statusText}` }
    }

    await response.json()
    return { success: true, statusCode: 200, message: '200' }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, message: 'Timeout', error: 'Request timeout after 10 seconds' }
      }
      return { success: false, message: 'Error', error: `Connection failed: ${error.message}` }
    }

    return { success: false, message: 'Error', error: 'An unknown error occurred' }
  }
}
