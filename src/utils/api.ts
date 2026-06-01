import type { TestResult, ChatMessage, ApiType, ProviderFormat } from '../types'

function truncateBody(body: string, maxLen: number = 2000): string {
  if (body.length <= maxLen) return body
  return body.slice(0, maxLen) + '...'
}

interface TestEndpoint {
  url: string
  body: object
  label: string
}

interface ParsedBody {
  isJson: boolean
  data?: any
}

const TEST_PROMPTS = ['Hi', 'Yes', 'No', 'Ok', 'Good', 'Bad', 'It', 'If', 'Then', 'Maybe', 'Yeah']
function randomPrompt(): string { return TEST_PROMPTS[Math.floor(Math.random() * TEST_PROMPTS.length)] }

function buildTestEndpoints(baseUrl: string, model: string, apiType: ApiType, format: ProviderFormat): TestEndpoint[] {
  const base = baseUrl.replace(/\/+$/, '')
  const endpoints: TestEndpoint[] = []
  const prompt = randomPrompt()

  if (format === 'anthropic') {
    const url = base.includes('/v1') ? `${base}/messages` : `${base}/v1/messages`
    endpoints.push({
      url,
      body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: 5 },
      label: 'messages',
    })
    return endpoints
  }

  if (apiType === 'chat' || apiType === 'both') {
    const chatUrl = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
    endpoints.push({
      url: chatUrl,
      body: { model, messages: [{ role: 'user', content: prompt }], max_tokens: 5 },
      label: 'chat',
    })
  }

  if (apiType === 'responses' || apiType === 'both') {
    const responsesUrl = base.includes('/v1') ? `${base}/responses` : `${base}/v1/responses`
    endpoints.push({
      url: responsesUrl,
      body: { model, input: [{ role: 'user', content: prompt }], max_output_tokens: 5 },
      label: 'responses',
    })
  }

  return endpoints
}

async function doTest(url: string, headers: Record<string, string>, body: object, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  const bodyText = await response.text()
  return { ok: response.ok, status: response.status, body: bodyText }
}

function parseBody(body: string): ParsedBody {
  try {
    return { isJson: true, data: JSON.parse(body) }
  } catch {
    return { isJson: false }
  }
}

function extractErrorMessage(data: any): string | undefined {
  const error = data?.error
  if (!error) return undefined
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string' && error.message.trim()) return error.message
  if (typeof data?.message === 'string' && data.message.trim()) return data.message
  try {
    return JSON.stringify(error)
  } catch {
    return 'API returned error'
  }
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string = 'gpt-3.5-turbo',
  apiType: ApiType = 'both',
  format: ProviderFormat = 'openai'
): Promise<TestResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (format === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  }

  const endpoints = buildTestEndpoints(baseUrl, model, apiType, format)

  if (endpoints.length === 0) {
    clearTimeout(timeoutId)
    return { success: false, message: 'Error', error: 'No test endpoints for apiType' }
  }

  try {
    const results: { label: string; success: boolean; statusCode: number; responseBody: string; error?: string }[] = []

    for (const endpoint of endpoints) {
      const result = await doTest(endpoint.url, headers, endpoint.body, controller.signal)
      const truncatedBody = truncateBody(result.body)

      if (result.ok) {
        results.push({ label: endpoint.label, success: true, statusCode: result.status, responseBody: truncatedBody })
      } else {
        const parsed = parseBody(result.body)
        const jsonError = parsed.isJson ? extractErrorMessage(parsed.data) : undefined
        results.push({
          label: endpoint.label,
          success: false,
          statusCode: result.status,
          responseBody: truncatedBody,
          error: jsonError || `${result.status}`,
        })
      }
    }

    clearTimeout(timeoutId)

    const anySuccess = results.some(r => r.success)
    const allSuccess = results.every(r => r.success)

    if (anySuccess) {
      const successResult = results.find(r => r.success)!
      const failedResults = results.filter(r => !r.success)
      const message = allSuccess
        ? `All endpoints OK (${results.map(r => r.label).join(', ')})`
        : `${successResult.label} OK${failedResults.length > 0 ? `, ${failedResults.map(r => `${r.label} failed (${r.error})`).join(', ')}` : ''}`

      return {
        success: true,
        statusCode: successResult.statusCode,
        message,
        responseBody: successResult.responseBody,
        endpoints: results.map(r => ({ label: r.label, success: r.success, statusCode: r.statusCode, error: r.error, responseBody: r.responseBody })),
      }
    }

    const firstFail = results[0]
    return {
      success: false,
      statusCode: firstFail.statusCode,
      message: results.map(r => `${r.label}: ${r.error}`).join('; '),
      error: results.map(r => `${r.label}: ${r.error}`).join('; '),
      responseBody: firstFail.responseBody,
      endpoints: results.map(r => ({ label: r.label, success: r.success, statusCode: r.statusCode, error: r.error, responseBody: r.responseBody })),
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, message: 'Timeout', error: 'Request timeout after 30 seconds' }
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
  apiType: ApiType = 'both',
  format: ProviderFormat = 'openai'
): AsyncGenerator<string, void, unknown> {
  const base = baseUrl.replace(/\/+$/, '')

  if (format === 'anthropic') {
    const url = base.includes('/v1') ? `${base}/messages` : `${base}/v1/messages`
    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: 4096,
      stream: true,
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (apiKey) headers['x-api-key'] = apiKey
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    yield* parseAnthropicStream(response)
    return
  }

  const useResponses = apiType === 'responses' || apiType === 'both'
  const useChat = apiType === 'chat' || apiType === 'both'

  let url: string
  let body: object

  if (useResponses) {
    url = base.includes('/v1') ? `${base}/responses` : `${base}/v1/responses`
    body = {
      model,
      input: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    }
  } else {
    url = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
    body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    if (useResponses && useChat) {
      const chatUrl = base.includes('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
      const chatBody = {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }
      const chatResponse = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(chatBody),
      })
      if (!chatResponse.ok) {
        throw new Error(`HTTP ${chatResponse.status}: ${chatResponse.statusText}`)
      }
      yield* parseStream(chatResponse, 'chat')
      return
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  yield* parseStream(response, useResponses ? 'responses' : 'chat')
}

async function* parseStream(response: Response, format: 'chat' | 'responses'): AsyncGenerator<string, void, unknown> {
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
        if (format === 'responses') {
          if (json.type === 'response.output_text.delta' && json.delta) {
            yield json.delta
          }
        } else {
          if (json.choices?.[0]?.delta?.content) {
            yield json.choices[0].delta.content
          }
        }
      } catch {}
    }
  }
}

async function* parseAnthropicStream(response: Response): AsyncGenerator<string, void, unknown> {
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
        if (json.type === 'content_block_delta' && json.delta?.text) {
          yield json.delta.text
        }
      } catch {}
    }
  }
}
