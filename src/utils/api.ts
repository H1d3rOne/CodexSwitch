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
      return handleError(response.status, response.statusText)
    }

    const data = await response.json()
    return {
      success: true,
      message: `Connection successful. Response: ${data.choices?.[0]?.message?.content || 'OK'}`,
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          message: 'Request timeout',
          error: 'Request timeout after 10 seconds',
        }
      }
      return {
        success: false,
        message: 'Connection failed',
        error: `Connection failed: ${error.message}`,
      }
    }

    return {
      success: false,
      message: 'Unknown error',
      error: 'An unknown error occurred',
    }
  }
}

function handleError(status: number, statusText: string): TestResult {
  switch (status) {
    case 401:
      return {
        success: false,
        message: 'Authentication failed',
        error: 'Invalid API Key',
      }
    case 403:
      return {
        success: false,
        message: 'Permission denied',
        error: 'Insufficient quota or permission denied',
      }
    case 500:
      return {
        success: false,
        message: 'Server error',
        error: 'Server error occurred',
      }
    default:
      return {
        success: false,
        message: `HTTP ${status}`,
        error: `Request failed with status ${status}: ${statusText}`,
      }
  }
}
