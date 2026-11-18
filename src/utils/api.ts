import type { TestResult, ChatMessage, ApiType, ProviderFormat } from '../types'
import { identityFetch } from './identityFetch'

/**
 * The provider model/type definitions are shared with the rest of the extension.
 * Keep these local aliases backwards-compatible while the storage/UI migration
 * adds DeepSeek's three-protocol values to the shared types.
 */
type SupportedApiType = ApiType | 'messages' | 'all'
type SupportedProviderFormat = ProviderFormat | 'deepseek'
type ApiProtocol = 'chat' | 'responses' | 'messages'

type RequestHeaders = Record<string, string>


function truncateBody(body: string, maxLen: number = 2000): string {
  if (body.length <= maxLen) return body
  return body.slice(0, maxLen) + '...'
}

interface TestEndpoint {
  url: string
  body: object
  label: ApiProtocol
  headers: RequestHeaders
  format: SupportedProviderFormat
}

interface ParsedBody {
  isJson: boolean
  data?: any
}

const TEST_PROMPTS = ['这是', 'emmm', '没事', '看看', 'wow', 'uhah', 'peace', 'oh', 'Then', 'Maybe', 'Yeah']
function randomPrompt(): string { return TEST_PROMPTS[Math.floor(Math.random() * TEST_PROMPTS.length)] }

function toAnthropicTextContent(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }> {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: toAnthropicTextContent(m.content),
    }))
}

function getAnthropicSystem(messages: ChatMessage[]): string | undefined {
  const system = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n')
    .trim()
  return system || undefined
}

function endpointUrl(baseUrl: string, endpoint: ApiProtocol): string {
  const base = baseUrl.replace(/\/+$/, '')
  const path = endpoint === 'chat'
    ? 'chat/completions'
    : endpoint
  return /(?:^|\/)v1$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`
}

function buildHeaders(
  apiKey: string,
  format: SupportedProviderFormat,
  protocol: ApiProtocol,
): RequestHeaders {
  const headers: RequestHeaders = { 'Content-Type': 'application/json' }

  if (protocol === 'messages') {
    // DeepSeek Harness exposes Anthropic Messages as a separate protocol. Send
    // both credentials accepted by Anthropic-compatible gateways: x-api-key is
    // the canonical Messages header, while Bearer keeps proxy gateways working.
    if (apiKey) headers['x-api-key'] = apiKey
    if (format === 'deepseek' && apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    headers['anthropic-version'] = '2023-06-01'
    return headers
  }

  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

function protocolsFor(apiType: SupportedApiType, format: SupportedProviderFormat): ApiProtocol[] {
  // Anthropic providers have historically ignored apiType and always used the
  // Messages protocol. Preserve that behavior for existing configurations.
  if (format === 'anthropic') return ['messages']

  if (apiType === 'chat') return ['chat']
  if (apiType === 'responses') return ['responses']
  if (apiType === 'messages') return format === 'deepseek' ? ['messages'] : []
  if (apiType === 'all') {
    return format === 'deepseek' ? ['chat', 'responses', 'messages'] : ['chat', 'responses']
  }
  // `both` is the legacy OpenAI value and intentionally means only the two
  // OpenAI-compatible protocols, never Anthropic Messages.
  return ['chat', 'responses']
}

function buildTestBody(protocol: ApiProtocol, model: string, prompt: string): object {
  if (protocol === 'messages') {
    return {
      model,
      messages: [{ role: 'user', content: toAnthropicTextContent(prompt) }],
      max_tokens: 128,
    }
  }

  if (protocol === 'responses') {
    // The Responses API enforces max_output_tokens >= 16; some relays reject
    // smaller values with a 400 instead of clamping.
    return {
      model,
      input: [{ role: 'user', content: prompt }],
      max_output_tokens: 16,
    }
  }

  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 5,
  }
}

function buildTestEndpoints(
  baseUrl: string,
  model: string,
  apiType: SupportedApiType,
  format: SupportedProviderFormat,
  apiKey: string,
): TestEndpoint[] {
  const prompt = randomPrompt()
  return protocolsFor(apiType, format).map(protocol => ({
    url: endpointUrl(baseUrl, protocol),
    body: buildTestBody(protocol, model, prompt),
    label: protocol,
    format,
    headers: buildHeaders(apiKey, format, protocol),
  }))
}

async function doTest(
  endpoint: TestEndpoint,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await identityFetch(endpoint.url, {
    method: 'POST',
    headers: endpoint.headers,
    body: JSON.stringify(endpoint.body),
    signal,
  }, endpoint.format, endpoint.label)
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Unknown error'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string = 'gpt-3.5-turbo',
  apiType: SupportedApiType = 'both',
  format: SupportedProviderFormat = 'openai'
): Promise<TestResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60000)
  const endpoints = buildTestEndpoints(baseUrl, model, apiType, format, apiKey)

  if (endpoints.length === 0) {
    clearTimeout(timeoutId)
    return { success: false, message: 'Error', error: 'No test endpoints for apiType' }
  }

  try {
    const results: {
      label: ApiProtocol
      success: boolean
      statusCode?: number
      responseBody: string
      error?: string
    }[] = []

    for (const endpoint of endpoints) {
      try {
        const result = await doTest(endpoint, controller.signal)
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
      } catch (error) {
        // A transport error on one protocol must not prevent a combined
        // DeepSeek/OpenAI test from checking the remaining protocols. An
        // AbortError is different: the shared timeout has expired, so stop
        // rather than issuing requests with an already-aborted signal.
        if (isAbortError(error)) throw error
        results.push({
          label: endpoint.label,
          success: false,
          statusCode: undefined,
          responseBody: '',
          error: errorMessage(error),
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
        endpoints: results.map(r => ({
          label: r.label,
          success: r.success,
          statusCode: r.statusCode ?? 0,
          error: r.error,
          responseBody: r.responseBody,
        })),
      }
    }

    const firstFail = results[0]
    const failureMessage = results.map(r => `${r.label}: ${r.error}`).join('; ')
    if (endpoints.length === 1 && firstFail.statusCode === undefined) {
      return {
        success: false,
        message: 'Error',
        error: `Connection failed: ${firstFail.error}`,
        responseBody: firstFail.responseBody,
        endpoints: results.map(r => ({
          label: r.label,
          success: r.success,
          statusCode: r.statusCode ?? 0,
          error: r.error,
          responseBody: r.responseBody,
        })),
      }
    }

    return {
      success: false,
      ...(firstFail.statusCode === undefined ? {} : { statusCode: firstFail.statusCode }),
      message: failureMessage,
      error: failureMessage,
      responseBody: firstFail.responseBody,
      endpoints: results.map(r => ({
        label: r.label,
        success: r.success,
        statusCode: r.statusCode ?? 0,
        error: r.error,
        responseBody: r.responseBody,
      })),
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { success: false, message: 'Timeout', error: 'Request timeout after 60 seconds' }
      }
      return { success: false, message: 'Error', error: `Connection failed: ${error.message}` }
    }

    return { success: false, message: 'Error', error: 'An unknown error occurred' }
  }
}

function buildStreamRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  protocol: ApiProtocol,
  format: SupportedProviderFormat,
): { url: string; headers: RequestHeaders; body: object } {
  if (protocol === 'messages') {
    const system = getAnthropicSystem(messages)
    const body: Record<string, unknown> = {
      model,
      messages: toAnthropicMessages(messages),
      max_tokens: 4096,
      stream: true,
    }
    if (system) body.system = system
    return {
      url: endpointUrl(baseUrl, protocol),
      headers: buildHeaders(apiKey, format, protocol),
      body,
    }
  }

  if (protocol === 'responses') {
    return {
      url: endpointUrl(baseUrl, protocol),
      headers: buildHeaders(apiKey, format, protocol),
      body: {
        model,
        input: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      },
    }
  }

  return {
    url: endpointUrl(baseUrl, protocol),
    headers: buildHeaders(apiKey, format, protocol),
    body: {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    },
  }
}

function responseError(response: Response, bodyText: string): Error {
  const parsed = parseBody(bodyText)
  const message = parsed.isJson ? extractErrorMessage(parsed.data) : undefined
  return new Error(`HTTP ${response.status}: ${message || response.statusText}`)
}

export async function* streamChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  apiType: SupportedApiType = 'chat',
  format: SupportedProviderFormat = 'openai'
): AsyncGenerator<string, void, unknown> {
  const protocols = protocolsFor(apiType, format)
  if (protocols.length === 0) throw new Error('No stream endpoint for apiType')

  let lastError: Error | undefined

  // For `both`/`all`, try protocols in stable order and only move on when the
  // request itself fails. Once a stream is accepted, its chunks are authoritative
  // and must not be duplicated by another endpoint.
  for (const protocol of protocols) {
    const request = buildStreamRequest(baseUrl, apiKey, model, messages, protocol, format)
    let response: Response

    try {
      response = await identityFetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
      }, format, protocol)

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        lastError = responseError(response, bodyText)
        continue
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown stream request error')
      // Explicit protocol selections should fail immediately. Combined modes
      // may use the next compatible protocol as a fallback.
      if (protocols.length === 1) throw lastError
      continue
    }

    // Do not fall back after a successful HTTP response: once a provider accepts
    // the stream, its SSE framing (including an empty or malformed body) belongs
    // to that protocol and should be surfaced to the caller unchanged.
    yield* parseStream(response, protocol)
    return
  }

  throw lastError || new Error('All stream endpoints failed')
}

async function* parseStream(response: Response, format: ApiProtocol): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  let eventName: string | undefined
  let dataLines: string[] = []

  const flushEvent = (): { chunks: string[]; done: boolean } => {
    if (dataLines.length === 0) {
      eventName = undefined
      return { chunks: [], done: false }
    }

    const data = dataLines.join('\n')
    const eventType = eventName
    eventName = undefined
    dataLines = []

    if (data === '[DONE]') return { chunks: [], done: true }

    const chunks: string[] = []

    try {
      const json = JSON.parse(data)
      const type = typeof json?.type === 'string' ? json.type : eventType

      if (format === 'responses') {
        if (type === 'response.output_text.delta' && typeof json.delta === 'string') chunks.push(json.delta)
      } else if (format === 'messages') {
        if (type === 'content_block_delta' && typeof json.delta?.text === 'string') chunks.push(json.delta.text)
      } else if (typeof json.choices?.[0]?.delta?.content === 'string') {
        chunks.push(json.choices[0].delta.content)
      }
    } catch {
      // Ignore non-JSON SSE metadata and incomplete provider events.
    }

    return { chunks, done: false }
  }

  const processLine = (line: string): { chunks: string[]; done: boolean } => {
    const trimmed = line.trim()
    if (!trimmed) return flushEvent()
    if (trimmed.startsWith(':')) return { chunks: [], done: false }

    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim()
    } else if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart())
    } else {
      // Keep compatibility with providers that send newline-delimited JSON
      // without the `data:` SSE field.
      dataLines.push(trimmed)
      return flushEvent()
    }
    return { chunks: [], done: false }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (const line of lines) {
      const event = processLine(line)
      for (const chunk of event.chunks) yield chunk
      if (event.done) return
    }

    if (done) {
      if (buffer) {
        const event = processLine(buffer)
        for (const chunk of event.chunks) yield chunk
        if (event.done) return
      }
      const event = flushEvent()
      for (const chunk of event.chunks) yield chunk
      return
    }
  }
}
