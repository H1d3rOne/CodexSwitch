import type { TestResult, ChatMessage } from '../types'

function truncateBody(body: string, maxLen: number = 2000): string {
  if (body.length <= maxLen) return body
  return body.slice(0, maxLen) + '...'
}

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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    const bodyText = await response.text()
    const truncatedBody = truncateBody(bodyText)

    if (!response.ok) {
      return { success: false, statusCode: response.status, message: `${response.status}`, error: `${response.status} ${response.statusText}`, responseBody: truncatedBody }
    }

    return { success: true, statusCode: 200, message: '200', responseBody: truncatedBody }
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

export async function* streamChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[]
): AsyncGenerator<string, void, unknown> {
  const url = baseUrl.endsWith('/')
    ? `${baseUrl}v1/chat/completions`
    : `${baseUrl}/v1/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        const content = json.choices?.[0]?.delta?.content
        if (content) yield content
      } catch {}
    }
  }
}
