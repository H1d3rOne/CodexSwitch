import type { TestResult, ChatMessage } from '../types'

function truncateBody(body: string, maxLen: number = 2000): string {
  if (body.length <= maxLen) return body
  return body.slice(0, maxLen) + '...'
}

function parseProxyUrl(proxyUrl: string): { scheme: string; host: string; port: number } | null {
  try {
    const url = new URL(proxyUrl)
    const scheme = url.protocol.replace(':', '')
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return null
    return { scheme, host: url.hostname, port: parseInt(url.port) || (scheme.startsWith('socks') ? 1080 : 8080) }
  } catch {
    return null
  }
}

async function withProxy<T>(proxyUrl: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!proxyUrl) return fn()

  const parsed = parseProxyUrl(proxyUrl)
  if (!parsed) return fn()

  const { scheme, host, port } = parsed
  const proxyConfig = {
    mode: "fixed_servers" as const,
    rules: {
      singleProxy: { scheme: scheme as 'http' | 'https' | 'socks4' | 'socks5', host, port },
      bypassList: ["localhost", "127.0.0.1"]
    }
  }

  try {
    await (chrome as any).proxy.settings.set({ value: proxyConfig, scope: 'regular' })
    const result = await fn()
    return result
  } finally {
    try {
      await (chrome as any).proxy.settings.clear({ scope: 'regular' })
    } catch {}
  }
}

async function doTest(url: string, headers: Record<string, string>, model: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10,
    }),
    signal,
  })
  const bodyText = await response.text()
  return { ok: response.ok, status: response.status, body: bodyText }
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string = 'gpt-3.5-turbo',
  proxyUrl?: string
): Promise<TestResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  function buildUrl(url: string): string {
    return url.endsWith('/') ? `${url}chat/completions` : `${url}/chat/completions`
  }

  try {
    const result = await withProxy(proxyUrl, async () => {
      return await doTest(buildUrl(baseUrl), headers, model, controller.signal)
    })
    clearTimeout(timeoutId)
    const truncatedBody = truncateBody(result.body)

    if (!result.ok) {
      return { success: false, statusCode: result.status, message: `${result.status}`, error: `${result.status}`, responseBody: truncatedBody }
    }

    let isJson = false
    try { JSON.parse(result.body); isJson = true } catch {}

    if (!isJson && !baseUrl.includes('/v1') && !baseUrl.includes('/v2')) {
      const v1Url = baseUrl.replace(/\/+$/, '') + '/v1'
      const retryResult = await withProxy(proxyUrl, async () => {
        return await doTest(buildUrl(v1Url), headers, model, controller.signal)
      })
      clearTimeout(timeoutId)
      const retryBody = truncateBody(retryResult.body)

      let retryIsJson = false
      try { JSON.parse(retryResult.body); retryIsJson = true } catch {}

      if (retryResult.ok && retryIsJson) {
        return { success: true, statusCode: 200, message: '200', responseBody: retryBody, correctedBaseUrl: v1Url }
      }

      return { success: false, statusCode: 200, message: '200', error: 'base_url is not correct', responseBody: truncatedBody }
    }

    if (!isJson) {
      return { success: false, statusCode: 200, message: '200', error: 'base_url is not correct', responseBody: truncatedBody }
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
  messages: ChatMessage[],
  proxyUrl?: string
): AsyncGenerator<string, void, unknown> {
  const url = baseUrl.endsWith('/')
    ? `${baseUrl}chat/completions`
    : `${baseUrl}/chat/completions`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const response = await withProxy(proxyUrl, async () => {
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: true }),
    })
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
