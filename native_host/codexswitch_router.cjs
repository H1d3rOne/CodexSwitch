#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const crypto = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')

const statePath = process.env.CODEXSWITCH_ROUTER_STATE || path.join(os.homedir(), '.codexswitch', 'router-state.json')
const pidPath = `${statePath}.pid`
const maxBodyBytes = 100 * 1024 * 1024
const protocolVerification = new Map()

function readState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function logRequestDiagnostic(event, fields) {
  console.log(JSON.stringify({ component: 'request', event, ...fields }))
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function getRequestToken(req) {
  const authorization = req.headers.authorization || ''
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)
  return bearer?.[1] || req.headers['x-api-key'] || req.headers['api-key'] || ''
}

function resolveUpstream(baseUrl, requestUrl) {
  const upstream = new URL(baseUrl)
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new Error('Provider URL must use http or https')
  }
  const incoming = new URL(requestUrl, 'http://127.0.0.1')
  const basePath = upstream.pathname.replace(/\/+$/, '')
  let incomingPath = incoming.pathname
  if (/\/v1$/i.test(basePath) && /^\/v1(?:\/|$)/i.test(incomingPath)) {
    incomingPath = incomingPath.slice(3) || '/'
  }
  if (!incomingPath.startsWith('/')) incomingPath = `/${incomingPath}`
  upstream.pathname = `${basePath}${incomingPath}` || '/'
  const search = new URLSearchParams(upstream.search)
  for (const [key, value] of incoming.searchParams) search.set(key, value)
  upstream.search = search.toString() ? `?${search.toString()}` : ''
  upstream.hash = ''
  return upstream
}

function replaceModel(body, model) {
  if (!body.length || !model) return body
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return body
    value.model = model
    return Buffer.from(JSON.stringify(value))
  } catch {
    return body
  }
}

function endpointKind(pathname) {
  if (/\/(?:chat\/completions)(?:\/|$)/i.test(pathname)) return 'chat'
  if (/\/responses(?:\/|$)/i.test(pathname)) return 'responses'
  if (/\/messages(?:\/|$)/i.test(pathname)) return 'messages'
  return null
}

function endpointPath(kind) {
  if (kind === 'chat') return '/v1/chat/completions'
  if (kind === 'responses') return '/v1/responses'
  if (kind === 'messages') return '/v1/messages'
  return null
}

function protocolVerificationKey(provider) {
  return crypto.createHash('sha256')
    .update([provider.id || '', provider.baseUrl || '', provider.model || '', provider.apiType || '', provider.format || ''].join('\0'))
    .digest('hex')
}

function getProtocolVerification(provider) {
  return protocolVerification.get(protocolVerificationKey(provider)) || new Map()
}

function setProtocolVerification(provider, kind, supported) {
  const key = protocolVerificationKey(provider)
  const status = protocolVerification.get(key) || new Map()
  status.set(kind, supported)
  protocolVerification.set(key, status)
}

function isProtocolFailure(statusCode, bodyText = '', provider, kind) {
  if (statusCode >= 200 && statusCode < 300) return false

  // A transient server failure is not proof that a protocol is unsupported.
  if (statusCode === 405 || statusCode === 501) return true
  if (statusCode !== 404) return false

  // A 404 can be a model error as well as an absent API route. Do not mark a
  // declared protocol invalid unless the response looks like a route error.
  const text = String(bodyText || '').toLowerCase()
  if (/model[_ -]not[_ -]found|unknown model|invalid model/.test(text)) return false
  if (!text.trim()) return true
  return /endpoint|route|path|method|not found|does not exist|unsupported/.test(text)
}

function isUpstreamModelError(statusCode, bodyText = '') {
  if (statusCode !== 404) return false
  return /model[_ -]not[_ -]found|unknown model|invalid model/.test(String(bodyText || '').toLowerCase())
}

function getUpstreamErrorMetadata(bodyText) {
  try {
    const value = JSON.parse(bodyText)
    const error = value?.error && typeof value.error === 'object' ? value.error : value
    const safeValue = field => typeof error?.[field] === 'string'
      ? error[field].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80)
      : undefined
    return {
      upstreamErrorType: safeValue('type'),
      upstreamErrorCode: safeValue('code'),
    }
  } catch {
    return {}
  }
}

function supportedKinds(provider) {
  if (provider.format === 'anthropic') return ['messages']
  const apiType = provider.apiType || (provider.format === 'deepseek' ? 'all' : 'chat')
  if (apiType === 'all') return ['chat', 'responses', 'messages']
  if (apiType === 'both') return ['chat', 'responses']
  return ['chat', 'responses', 'messages'].includes(apiType) ? [apiType] : ['chat']
}
function targetKindForProvider(provider, sourceKind) {
  const kinds = supportedKinds(provider)
  const preferred = kinds.includes(sourceKind) ? sourceKind : kinds[0]
  const verified = getProtocolVerification(provider)
  return verified.get(preferred) === false ? kinds.find(kind => verified.get(kind) !== false) || preferred : preferred
}

function setDefined(target, key, value) {
  if (value !== undefined) target[key] = value
}

function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('')
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    try { return JSON.stringify(value) } catch {}
  }
  return ''
}

function parseJsonValue(value, fallback = {}) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : fallback
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function openAiContentToAnthropic(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : String(content)
  return content.map(part => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') }
    if (part.type === 'text' || part.type === 'input_text') return { type: 'text', text: part.text || '' }
    if (part.type === 'tool_result') return { type: 'tool_result', tool_use_id: part.tool_use_id, content: asText(part.content), ...(part.is_error === undefined ? {} : { is_error: part.is_error }) }
    if (part.type === 'image' && part.source) return part
    if (part.type === 'image_url' && part.image_url) {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url
      if (typeof url === 'string' && url.startsWith('data:')) {
        const match = url.match(/^data:([^;,]+);base64,(.*)$/)
        if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
      }
      if (url) return { type: 'image', source: { type: 'url', url } }
    }
    if (part.type === 'input_image' && part.image_url) {
      return openAiContentToAnthropic([{ type: 'image_url', image_url: part.image_url }])[0]
    }
    return { type: 'text', text: asText(part) }
  })
}

function anthropicContentToOpenAi(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : String(content)
  return content.map(part => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') }
    if (part.type === 'text') return { type: 'text', text: part.text || '' }
    if (part.type === 'input_text') return { type: 'text', text: part.text || '' }
    if (part.type === 'input_image') {
      const imageUrl = part.image_url || (part.image && part.image.url)
      if (imageUrl) {
        const url = typeof imageUrl === 'string' ? imageUrl : imageUrl.url
        return {
          type: 'image_url',
          image_url: {
            url,
            ...(part.detail === 'auto' || part.detail === 'low' || part.detail === 'high' ? { detail: part.detail } : {}),
          },
        }
      }
    }
    if (part.type === 'image' && part.source) {
      const source = part.source
      if (source.type === 'url') return { type: 'image_url', image_url: { url: source.url } }
      if (source.data) return { type: 'image_url', image_url: { url: `data:${source.media_type || 'image/png'};base64,${source.data}` } }
    }
    if (part.type === 'image_url') return part
    if (part.type === 'tool_result') return { type: 'text', text: asText(part.content) }
    if (part.type === 'tool_use') return { type: 'text', text: '' }
    return { type: 'text', text: asText(part) }
  })
}

// Chat Completions and Anthropic Messages can express function tools, but
// freeform and server-side built-ins must not be forwarded verbatim. Chat and
// Messages gateways reject the whole request when they see these types.
const chatIncompatibleToolTypes = new Set([
  'custom',
  'web_search',
  'web_search_preview',
  'web_search_preview_2025_03_11',
  'web_search_20250305',
  'web_search_20260209',
  'file_search',
  'code_interpreter',
  'image_generation',
  'computer_use',
  'computer_use_preview',
  'local_shell',
  'mcp',
  'container',
])

// Anthropic Messages validates the tool type exactly and only accepts raw
// `web_search` under a versioned server-tool name.
const anthropicWebSearchTypes = new Map([
  ['web_search', 'web_search_20250305'],
  ['web_search_preview', 'web_search_20250305'],
  ['web_search_preview_2025_03_11', 'web_search_20250305'],
  ['web_search_20250305', 'web_search_20250305'],
  ['web_search_20260209', 'web_search_20260209'],
])

const anthropicIncompatibleToolTypes = new Set(['custom'])

function isChatIncompatibleTool(tool) {
  if (!tool || typeof tool !== 'object') return false
  return chatIncompatibleToolTypes.has(String(tool.type || '').toLowerCase())
}

function toAnthropicServerTool(tool) {
  const type = anthropicWebSearchTypes.get(String(tool?.type || '').toLowerCase())
  if (!type) return null
  const converted = { type, name: 'web_search' }
  for (const key of ['max_uses', 'allowed_domains', 'blocked_domains', 'user_location']) {
    if (tool[key] !== undefined) converted[key] = tool[key]
  }
  return converted
}

function responseToolsToChat(tools, { keepChatIncompatible = false } = {}) {
  if (!Array.isArray(tools)) return undefined
  const converted = tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool
    if (tool.type === 'function' && tool.function) return tool
    if (tool.type === 'function') {
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} },
          strict: tool.strict,
        },
      }
    }
    return tool
  })
  if (keepChatIncompatible) return converted
  const supported = converted.filter(tool => !isChatIncompatibleTool(tool))
  return supported.length > 0 ? supported : undefined
}

function chatToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined
  const converted = tools.map(tool => {
    if (!tool || typeof tool !== 'object') return null
    if (tool.type === 'function' && tool.function) {
      return {
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
      }
    }
    const serverTool = toAnthropicServerTool(tool)
    if (serverTool) return serverTool
    if (anthropicIncompatibleToolTypes.has(String(tool.type || '').toLowerCase())) return null
    if (tool.name) {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
      }
    }
    return null
  }).filter(Boolean)
  return converted.length > 0 ? converted : undefined
}

function anthropicToolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined
  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') return tool
    if (tool.type === 'function' && tool.function) return tool
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }
  })
}

function toChatToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice
  if (choice.type === 'auto' || choice.type === 'none') return choice.type
  if (choice.type === 'function' && choice.name) return { type: 'function', function: { name: choice.name } }
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } }
  if (choice.type === 'any') return 'required'
  return choice
}

function toAnthropicToolChoice(choice) {
  if (!choice || typeof choice !== 'object') {
    if (choice === 'required') return { type: 'any' }
    if (choice === 'auto' || choice === 'none') return { type: choice }
    return choice
  }
  if (choice.type === 'function' && choice.function?.name) return { type: 'tool', name: choice.function.name }
  if (choice.type === 'function' && choice.name) return { type: 'tool', name: choice.name }
  return choice
}

function responsesInputToChat(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  const messages = []
  let pendingUser = null
  const flushPendingUser = () => {
    if (pendingUser) {
      messages.push({ role: 'user', content: pendingUser.length === 1 && typeof pendingUser[0] === 'string' ? pendingUser[0] : pendingUser })
      pendingUser = null
    }
  }
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message' || (item.role && item.content !== undefined)) {
      flushPendingUser()
      messages.push({ role: item.role || 'user', content: anthropicContentToOpenAi(item.content) })
    } else if (item.type === 'input_text' || item.type === 'input_image') {
      if (!pendingUser) pendingUser = []
      pendingUser.push(item.type === 'input_text'
        ? { type: 'text', text: item.text || '' }
        : {
            type: 'image_url',
            image_url: {
              url: typeof item.image_url === 'string' ? item.image_url : item.image_url?.url,
              ...(item.detail === 'auto' || item.detail === 'low' || item.detail === 'high' ? { detail: item.detail } : {}),
            },
          })
    } else if (item.type === 'function_call') {
      flushPendingUser()
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${crypto.randomBytes(6).toString('hex')}`,
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        }],
      })
    } else if (item.type === 'function_call_output') {
      flushPendingUser()
      messages.push({ role: 'tool', tool_call_id: item.call_id || item.id, content: asText(item.output) })
    }
  }
  flushPendingUser()
  return messages
}

function chatMessagesToResponsesInput(messages) {
  const input = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: asText(message.content) })
      continue
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name || '',
          arguments: call.function?.arguments || '{}',
        })
      }
    }
    input.push({
      type: 'message',
      role: message.role || 'user',
      content: Array.isArray(message.content)
        ? message.content.map(part => part?.type === 'text' ? { type: 'input_text', text: part.text || '' } : part)
        : [{ type: 'input_text', text: asText(message.content) }],
    })
  }
  return input
}

function anthropicMessagesToChat(body) {
  const messages = []
  if (body.system !== undefined) messages.push({ role: 'system', content: anthropicContentToOpenAi(body.system) })
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') continue
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: asText(message.content) }]
    const toolUses = content.filter(part => part?.type === 'tool_use')
    const toolResults = content.filter(part => part?.type === 'tool_result')
    const regular = content.filter(part => part?.type !== 'tool_use' && part?.type !== 'tool_result')
    if (message.role === 'assistant' && toolUses.length > 0) {
      messages.push({
        role: 'assistant',
        content: regular.length > 0 ? anthropicContentToOpenAi(regular) : null,
        tool_calls: toolUses.map(part => ({
          id: part.id,
          type: 'function',
          function: { name: part.name || '', arguments: JSON.stringify(part.input || {}) },
        })),
      })
    } else if (toolResults.length > 0) {
      if (regular.length > 0) messages.push({ role: message.role || 'user', content: anthropicContentToOpenAi(regular) })
      for (const result of toolResults) {
        messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: asText(result.content) })
      }
    } else {
      messages.push({ role: message.role || 'user', content: anthropicContentToOpenAi(message.content) })
    }
  }
  return messages
}

function chatRequestFromMessages(body, model) {
  const result = {
    model,
    messages: anthropicMessagesToChat(body),
  }
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'stream_options', 'metadata', 'user', 'seed', 'presence_penalty', 'frequency_penalty', 'logprobs', 'top_logprobs', 'n', 'response_format', 'stop']) setDefined(result, key, body[key])
  setDefined(result, 'max_tokens', body.max_tokens || body.max_completion_tokens)
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences
  const tools = anthropicToolsToChat(body.tools)
  if (tools) result.tools = tools
  if (body.tool_choice !== undefined) result.tool_choice = toChatToolChoice(body.tool_choice)
  return result
}

function chatRequestFromResponses(body, model, options = {}) {
  const result = {
    model,
    messages: [],
  }
  if (body.instructions !== undefined) result.messages.push({ role: 'system', content: anthropicContentToOpenAi(body.instructions) })
  result.messages.push(...responsesInputToChat(body.input))
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user', 'seed', 'presence_penalty', 'frequency_penalty', 'stop']) setDefined(result, key, body[key])
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort
  if (body.text?.format?.type === 'json_object') result.response_format = { type: 'json_object' }
  if (body.text?.format?.type === 'json_schema') {
    result.response_format = {
      type: 'json_schema',
      json_schema: {
        name: body.text.format.name || 'response',
        schema: body.text.format.schema || {},
        strict: body.text.format.strict,
      },
    }
  }
  setDefined(result, 'max_tokens', body.max_output_tokens || body.max_completion_tokens)
  const tools = responseToolsToChat(body.tools, options)
  if (tools) result.tools = tools
  if (body.tool_choice !== undefined) result.tool_choice = toChatToolChoice(body.tool_choice)
  return result
}

function responsesToolsFromChat(tools) {
  if (!Array.isArray(tools)) return undefined
  return tools.map(tool => {
    if (tool?.type !== 'function' || !tool.function) return tool
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters || { type: 'object', properties: {} },
      strict: tool.function.strict,
    }
  })
}

function responsesRequestFromChat(body, model) {
  const system = (Array.isArray(body.messages) ? body.messages : [])
    .filter(message => message?.role === 'system' || message?.role === 'developer')
    .map(message => asText(message.content))
    .filter(Boolean)
  const result = {
    model,
    input: chatMessagesToResponsesInput(body.messages),
  }
  if (system.length) result.instructions = system.join('\n\n')
  for (const key of ['stream', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user', 'seed', 'presence_penalty', 'frequency_penalty', 'stop']) setDefined(result, key, body[key])
  setDefined(result, 'max_output_tokens', body.max_output_tokens || body.max_completion_tokens || body.max_tokens)
  if (body.reasoning_effort) result.reasoning = { effort: body.reasoning_effort }
  if (body.response_format?.type === 'json_object') result.text = { format: { type: 'json_object' } }
  if (body.response_format?.type === 'json_schema') {
    const schema = body.response_format.json_schema || {}
    result.text = { format: { type: 'json_schema', name: schema.name || 'response', schema: schema.schema || {}, strict: schema.strict } }
  }
  const tools = responsesToolsFromChat(body.tools)
  if (tools) result.tools = tools
  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'required') result.tool_choice = 'required'
    else if (body.tool_choice === 'none' || body.tool_choice === 'auto') result.tool_choice = body.tool_choice
    else if (body.tool_choice?.type === 'function' && body.tool_choice.function?.name) {
      result.tool_choice = { type: 'function', name: body.tool_choice.function.name }
    } else result.tool_choice = body.tool_choice
  }
  return result
}

function responsesRequestFromMessages(body, model) {
  return responsesRequestFromChat(chatRequestFromMessages(body, model), model)
}

function messagesRequestFromChat(body, model) {
  const system = []
  const messages = []
  const sourceMessages = Array.isArray(body.messages) ? body.messages : []
  for (let index = 0; index < sourceMessages.length; index += 1) {
    const message = sourceMessages[index]
    if (message?.role === 'system' || message?.role === 'developer') {
      const converted = openAiContentToAnthropic(message.content)
      if (Array.isArray(converted)) system.push(...converted)
      else if (converted !== '') system.push({ type: 'text', text: converted })
    }
    else if (message?.role === 'tool') {
      const results = []
      while (index < sourceMessages.length && sourceMessages[index]?.role === 'tool') {
        const toolMessage = sourceMessages[index]
        results.push({ type: 'tool_result', tool_use_id: toolMessage.tool_call_id, content: asText(toolMessage.content) })
        index += 1
      }
      index -= 1
      messages.push({ role: 'user', content: results })
    } else messages.push(message)
  }
  const result = {
    model,
    messages: messages.map(message => {
      const content = []
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const converted = openAiContentToAnthropic(message.content)
        if (Array.isArray(converted)) content.push(...converted)
        else if (converted !== '') content.push({ type: 'text', text: converted })
        for (const call of message.tool_calls) content.push({ type: 'tool_use', id: call.id, name: call.function?.name || '', input: parseJsonValue(call.function?.arguments, {}) })
      } else {
        const converted = openAiContentToAnthropic(message.content)
        if (Array.isArray(converted)) content.push(...converted)
        else content.push({ type: 'text', text: converted })
      }
      return { role: message.role === 'tool' ? 'user' : (message.role || 'user'), content }
    }),
  }
  if (system.length > 0) {
    const allText = system.every(part => part?.type === 'text')
    result.system = allText ? system.map(part => part.text || '').join('\n') : system
  }
  for (const key of ['stream', 'temperature', 'top_p', 'metadata']) setDefined(result, key, body[key])
  result.max_tokens = body.max_tokens ?? body.max_completion_tokens ?? 4096
  if (body.stop !== undefined) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  const tools = chatToolsToAnthropic(body.tools)
  if (tools) result.tools = tools
  if (body.tool_choice !== undefined) result.tool_choice = toAnthropicToolChoice(body.tool_choice)
  return result
}

function messagesRequestFromResponses(body, model) {
  // Responses -> Chat is only an intermediate hop here: keep the built-in
  // tools so the final Messages conversion can map them to Anthropic's
  // versioned server tools instead of dropping them.
  const chat = chatRequestFromResponses(body, model, { keepChatIncompatible: true })
  return messagesRequestFromChat(chat, model)
}

function convertRequestValue(body, source, target, model) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON request body must be an object')
  if (source === target) return { ...body, model }
  if (target === 'chat') {
    if (source === 'messages') return chatRequestFromMessages(body, model)
    if (source === 'responses') return chatRequestFromResponses(body, model)
  }
  if (target === 'responses') {
    if (source === 'chat') return responsesRequestFromChat(body, model)
    if (source === 'messages') return responsesRequestFromMessages(body, model)
  }
  if (target === 'messages') {
    if (source === 'chat') return messagesRequestFromChat(body, model)
    if (source === 'responses') return messagesRequestFromResponses(body, model)
  }
  throw new Error(`Unsupported protocol conversion: ${source} to ${target}`)
}

function replaceRequestModel(body, source, target, model) {
  if (!body.length) return { body, converted: false, stream: false }
  try {
    const value = JSON.parse(body.toString('utf8'))
    const result = convertRequestValue(value, source, target, model || value.model)
    return {
      body: Buffer.from(JSON.stringify(result)),
      converted: source !== target,
      stream: result.stream === true,
    }
  } catch (error) {
    if (source !== target) throw error
    return { body, converted: false, stream: false }
  }
}

function responseTextFromChat(message) {
  return asText(message?.content)
}

function responseContentFromMessages(content) {
  return (Array.isArray(content) ? content : []).filter(part => part?.type === 'text').map(part => part.text || '').join('')
}

function usageFromChat(usage) {
  return {
    input_tokens: usage?.prompt_tokens || usage?.input_tokens || 0,
    output_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
  }
}

function usageToChat(usage) {
  const input = usage?.input_tokens || usage?.prompt_tokens || 0
  const output = usage?.output_tokens || usage?.completion_tokens || 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  }
}

function finishReasonToChat(reason) {
  if (!reason) return 'stop'
  if (reason === 'end_turn' || reason === 'stop') return 'stop'
  if (reason === 'max_tokens' || reason === 'length') return 'length'
  if (reason === 'tool_use' || reason === 'tool_calls') return 'tool_calls'
  return reason
}

function finishReasonToAnthropic(reason) {
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return reason === 'stop' ? 'end_turn' : (reason || 'end_turn')
}

function responseIncompleteReason(reason) {
  if (reason === 'content_filter') return 'content_filter'
  return 'max_output_tokens'
}

function chatResponseToMessages(value) {
  const choice = value.choices?.[0] || {}
  const message = choice.message || {}
  const content = []
  const text = responseTextFromChat(message)
  if (text) content.push({ type: 'text', text })
  for (const call of message.tool_calls || []) {
    content.push({ type: 'tool_use', id: call.id, name: call.function?.name || '', input: parseJsonValue(call.function?.arguments, {}) })
  }
  return {
    id: value.id || `msg_${crypto.randomBytes(8).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: value.model,
    content,
    stop_reason: finishReasonToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: usageFromChat(value.usage),
  }
}

function chatResponseToResponses(value) {
  const choice = value.choices?.[0] || {}
  const message = choice.message || {}
  const output = []
  const messageId = `msg_${String(value.id || crypto.randomBytes(8).toString('hex')).replace(/[^A-Za-z0-9_-]/g, '')}`
  const text = responseTextFromChat(message)
  if (text || !(message.tool_calls || []).length) {
    output.push({
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const call of message.tool_calls || []) {
    output.push({
      id: call.id || `fc_${crypto.randomBytes(8).toString('hex')}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.function?.name || '',
      arguments: call.function?.arguments || '{}',
    })
  }
  const usage = usageFromChat(value.usage)
  return {
    id: value.id ? `resp_${String(value.id).replace(/^resp_/, '')}` : `resp_${crypto.randomBytes(8).toString('hex')}`,
    object: 'response',
    created_at: value.created || Math.floor(Date.now() / 1000),
    status: 'completed',
    background: false,
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: value.model,
    output,
    output_text: text,
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    tools: [],
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens },
  }
}

function messagesResponseToChat(value) {
  const toolCalls = (value.content || []).filter(part => part?.type === 'tool_use').map(part => ({
    id: part.id,
    type: 'function',
    function: { name: part.name || '', arguments: JSON.stringify(part.input || {}) },
  }))
  const text = responseContentFromMessages(value.content)
  return {
    id: value.id || `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: value.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReasonToChat(value.stop_reason),
    }],
    usage: usageToChat(value.usage),
  }
}

function responsesOutputToChat(value) {
  const messages = []
  for (const item of value.output || []) {
    if (item?.type === 'message') {
      messages.push({ role: item.role || 'assistant', content: responseContentFromMessages(item.content) || asText(item.content) })
    } else if (item?.type === 'function_call') {
      const last = messages[messages.length - 1]
      const target = last?.role === 'assistant' ? last : { role: 'assistant', content: null }
      if (!last) messages.push(target)
      if (!target.tool_calls) target.tool_calls = []
      target.tool_calls.push({ id: item.call_id || item.id, type: 'function', function: { name: item.name || '', arguments: item.arguments || '{}' } })
    }
  }
  const message = messages[0] || { role: 'assistant', content: value.output_text || '' }
  const toolCalls = message.tool_calls || []
  return {
    id: value.id || `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: value.created_at || Math.floor(Date.now() / 1000),
    model: value.model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? 'tool_calls' : (value.status === 'incomplete' ? 'length' : 'stop') }],
    usage: usageToChat(value.usage),
  }
}

function validateResponseValue(value, source) {
  const isObject = item => item !== null && typeof item === 'object' && !Array.isArray(item)
  if (!isObject(value) || value.error) throw new Error('Invalid upstream response')
  let valid = false
  if (source === 'chat') {
    valid = Array.isArray(value.choices) && isObject(value.choices[0]) && isObject(value.choices[0].message)
  } else if (source === 'messages') {
    valid = value.type === 'message' && Array.isArray(value.content)
  } else if (source === 'responses') {
    valid = Array.isArray(value.output) && [undefined, 'completed', 'incomplete'].includes(value.status)
  }
  if (!valid) throw new Error('Invalid upstream response')
}

function convertResponseValue(value, source, target) {
  validateResponseValue(value, source)
  if (source === target) return value
  if (source === 'chat' && target === 'messages') return chatResponseToMessages(value)
  if (source === 'chat' && target === 'responses') return chatResponseToResponses(value)
  if (source === 'messages' && target === 'chat') return messagesResponseToChat(value)
  if (source === 'messages' && target === 'responses') return chatResponseToResponses(messagesResponseToChat(value))
  if (source === 'responses' && target === 'chat') return responsesOutputToChat(value)
  if (source === 'responses' && target === 'messages') return chatResponseToMessages(responsesOutputToChat(value))
  throw new Error(`Unsupported protocol conversion: ${source} to ${target}`)
}

function makeStreamId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`
}

function sseData(event, value) {
  const lines = []
  if (event) lines.push(`event: ${event}`)
  lines.push(`data: ${JSON.stringify(value)}`)
  return `${lines.join('\n')}\n\n`
}

function createStreamConverter(source, target, model, res) {
  const state = {
    id: makeStreamId(target === 'responses' ? 'resp' : target === 'messages' ? 'msg' : 'chatcmpl'),
    messageId: makeStreamId('msg'),
    model,
    created: Math.floor(Date.now() / 1000),
    text: '',
    finishReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    started: false,
    finished: false,
    toolCalls: new Map(),
    textBlockStarted: false,
    textBlockIndex: null,
    responseTextOutputIndex: null,
    nextBlockIndex: 0,
    nextOutputIndex: 0,
    sequence: 0,
  }

  const write = (event, value) => {
    if (!res.writableEnded) {
      const payload = target === 'responses' && value && typeof value === 'object'
        ? { ...value, sequence_number: state.sequence }
        : value
      state.sequence += 1
      res.write(sseData(event, payload))
    }
  }
  const ensureStarted = () => {
    if (state.started) return
    state.started = true
    if (target === 'chat') {
      write('', { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    } else if (target === 'messages') {
      write('message_start', { type: 'message_start', message: { id: state.id, type: 'message', role: 'assistant', model: state.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: state.usage.input_tokens, output_tokens: 0 } } })
    } else {
      const response = { id: state.id, object: 'response', created_at: state.created, status: 'in_progress', model: state.model, output: [], error: null, usage: null }
      write('response.created', { type: 'response.created', response })
      write('response.in_progress', { type: 'response.in_progress', response })
    }
  }
  const ensureResponseTextStarted = () => {
    if (state.responseTextOutputIndex !== null) return
    state.responseTextOutputIndex = state.nextOutputIndex++
    write('response.output_item.added', { type: 'response.output_item.added', output_index: state.responseTextOutputIndex, item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
    write('response.content_part.added', { type: 'response.content_part.added', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  }
  const emitText = text => {
    if (!text) return
    ensureStarted()
    state.text += text
    if (target === 'chat') write('', { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
    else if (target === 'messages') {
      if (!state.textBlockStarted) {
        state.textBlockStarted = true
        state.textBlockIndex = state.nextBlockIndex++
        write('content_block_start', { type: 'content_block_start', index: state.textBlockIndex, content_block: { type: 'text', text: '' } })
      }
      write('content_block_delta', { type: 'content_block_delta', index: state.textBlockIndex, delta: { type: 'text_delta', text } })
    } else {
      ensureResponseTextStarted()
      write('response.output_text.delta', { type: 'response.output_text.delta', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, delta: text })
    }
  }
  const emitToolStart = (index, id, name, callId) => {
    const key = index === undefined || index === null ? state.toolCalls.size : String(index)
    if (state.toolCalls.has(key)) {
      const existing = state.toolCalls.get(key)
      if (!existing.callId && (callId || id)) existing.callId = callId || id
      if (name) existing.name += name
      return existing
    }
    const actualCallId = callId || (target === 'responses' ? id : null) || makeStreamId('call')
    const itemId = target === 'responses'
      ? (id && String(id).startsWith('fc_') ? id : `fc_${actualCallId}`)
      : actualCallId
    const tool = { id: itemId, callId: actualCallId, name: name || '', args: '', targetIndex: state.toolCalls.size, blockIndex: state.nextBlockIndex++, outputIndex: state.nextOutputIndex++ }
    state.toolCalls.set(key, tool)
    ensureStarted()
    if (target === 'chat') write('', { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [{ index: 0, delta: { tool_calls: [{ index: tool.targetIndex, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] }, finish_reason: null }] })
    else if (target === 'messages') write('content_block_start', { type: 'content_block_start', index: tool.blockIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
    else write('response.output_item.added', { type: 'response.output_item.added', output_index: tool.outputIndex, item: { id: tool.id, type: 'function_call', status: 'in_progress', call_id: tool.callId, name: tool.name, arguments: '' } })
    return tool
  }
  const emitToolArgs = (index, args) => {
    if (!args) return
    const tool = emitToolStart(index)
    tool.args += args
    if (target === 'chat') write('', { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [{ index: 0, delta: { tool_calls: [{ index: tool.targetIndex, function: { arguments: args } }] }, finish_reason: null }] })
    else if (target === 'messages') write('content_block_delta', { type: 'content_block_delta', index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: args } })
    else write('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.outputIndex, delta: args })
  }
  const finish = reason => {
    if (state.finished) return
    state.finished = true
    state.finishReason = state.finishReason || reason || 'stop'
    ensureStarted()
    if (state.error) {
      if (target === 'chat') {
        write('', { error: state.error })
        if (!res.writableEnded) res.write('data: [DONE]\n\n')
      } else if (target === 'messages') {
        write('error', { type: 'error', error: state.error })
      } else {
        write('response.failed', {
          type: 'response.failed',
          response: { id: state.id, object: 'response', created_at: state.created, status: 'failed', model: state.model, error: state.error },
        })
      }
      return
    }
    for (const tool of state.toolCalls.values()) {
      if (target === 'messages') write('content_block_stop', { type: 'content_block_stop', index: tool.blockIndex })
      if (target === 'responses') {
        write('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: tool.id, output_index: tool.outputIndex, arguments: tool.args })
      }
    }
    if (target === 'chat') {
      write('', { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [{ index: 0, delta: {}, finish_reason: finishReasonToChat(state.finishReason) }], usage: usageToChat(state.usage) })
      if (!res.writableEnded) res.write('data: [DONE]\n\n')
    } else if (target === 'messages') {
      if (state.textBlockStarted) write('content_block_stop', { type: 'content_block_stop', index: state.textBlockIndex })
      write('message_delta', { type: 'message_delta', delta: { stop_reason: finishReasonToAnthropic(state.finishReason), stop_sequence: null }, usage: { output_tokens: state.usage.output_tokens } })
      write('message_stop', { type: 'message_stop' })
    } else {
      if (state.text) {
        write('response.output_text.done', { type: 'response.output_text.done', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, text: state.text })
        write('response.content_part.done', { type: 'response.content_part.done', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, part: { type: 'output_text', text: state.text, annotations: [] } })
      }
      if (!state.text && state.toolCalls.size === 0) {
        ensureResponseTextStarted()
        write('response.output_text.done', { type: 'response.output_text.done', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, text: '' })
        write('response.content_part.done', { type: 'response.content_part.done', item_id: state.messageId, output_index: state.responseTextOutputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      }
      const output = []
      if (state.responseTextOutputIndex !== null) {
        const messageItem = { id: state.messageId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: state.text, annotations: [] }] }
        output.push({ outputIndex: state.responseTextOutputIndex, item: messageItem })
      }
      for (const tool of state.toolCalls.values()) {
        const item = { id: tool.id, type: 'function_call', status: 'completed', call_id: tool.callId, name: tool.name, arguments: tool.args }
        output.push({ outputIndex: tool.outputIndex, item })
      }
      output.sort((left, right) => left.outputIndex - right.outputIndex)
      for (const entry of output) {
        write('response.output_item.done', { type: 'response.output_item.done', output_index: entry.outputIndex, item: entry.item })
      }
      const incomplete = ['length', 'max_tokens', 'content_filter'].includes(state.finishReason)
      const response = { id: state.id, object: 'response', created_at: state.created, status: incomplete ? 'incomplete' : 'completed', model: state.model, output: output.map(entry => entry.item), usage: { input_tokens: state.usage.input_tokens, output_tokens: state.usage.output_tokens, total_tokens: state.usage.input_tokens + state.usage.output_tokens } }
      if (incomplete) response.incomplete_details = { reason: responseIncompleteReason(state.finishReason) }
      write(incomplete ? 'response.incomplete' : 'response.completed', { type: incomplete ? 'response.incomplete' : 'response.completed', response })
    }
  }

  const consume = (event, value) => {
    if (value === '[DONE]') return finish('stop')
    if (!value || typeof value !== 'object') return
    if (state.finished) return
    if (source === 'chat') {
      if (value.error) {
        state.error = value.error
        finish('error')
        return
      }
      const choice = value.choices?.[0]
      const delta = choice?.delta || {}
      const message = choice?.message || {}
      if (value.usage) state.usage = usageFromChat(value.usage)
      emitText(delta.content || message.content || '')
      for (const call of (delta.tool_calls || message.tool_calls || [])) {
        const key = `${choice?.index || 0}:${Number.isInteger(call.index) ? call.index : 0}`
        emitToolStart(key, call.id, call.function?.name, call.id)
        emitToolArgs(key, call.function?.arguments || '')
      }
      if (choice?.finish_reason) state.finishReason = choice.finish_reason
    } else if (source === 'messages') {
      if (value.type === 'message_start') {
        state.id = value.message?.id || state.id
        state.model = value.message?.model || state.model
        if (value.message?.usage) state.usage = usageFromChat(value.message.usage)
        ensureStarted()
      } else if (value.type === 'content_block_start') {
        if (value.content_block?.type === 'tool_use') emitToolStart(value.index, value.content_block.id, value.content_block.name, value.content_block.id)
      } else if (value.type === 'content_block_delta') {
        if (value.delta?.type === 'text_delta') emitText(value.delta.text || '')
        if (value.delta?.type === 'input_json_delta') emitToolArgs(value.index, value.delta.partial_json || '')
      } else if (value.type === 'message_delta') {
        if (value.usage) state.usage.output_tokens = value.usage.output_tokens || 0
        if (value.delta?.stop_reason) state.finishReason = value.delta.stop_reason
      } else if (value.type === 'message_stop') finish(state.finishReason || 'stop')
      else if (value.type === 'error') {
        state.error = value.error || { message: value.message || 'Upstream response failed' }
        finish('error')
      }
    } else if (source === 'responses') {
      const type = value.type || event
      if (type === 'response.created') {
        state.id = value.response?.id || state.id
        state.model = value.response?.model || state.model
        ensureStarted()
      } else if (type === 'response.output_text.delta') emitText(value.delta || '')
      else if (type === 'response.function_call_arguments.delta') emitToolArgs(value.output_index, value.delta || '')
      else if (type === 'response.output_item.added' && value.item?.type === 'function_call') emitToolStart(value.output_index, value.item.id, value.item.name, value.item.call_id)
      else if (type === 'response.completed') {
        if (value.response?.usage) state.usage = usageFromChat(value.response.usage)
        finish(value.response?.status === 'incomplete' ? 'length' : state.toolCalls.size > 0 ? 'tool_calls' : 'stop')
      } else if (type === 'response.failed' || type === 'error') {
        state.error = value.error || value.response?.error || { message: value.message || 'Upstream response failed' }
        finish('error')
      }
    }
  }

  let buffer = ''
  const decoder = new StringDecoder('utf8')
  const consumeBlock = block => {
    let event = ''
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const raw = data.join('\n')
    if (!raw) return
    let value = raw
    try { value = JSON.parse(raw) } catch {}
    consume(event, value)
  }
  const parseBuffer = flushTail => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/)
      if (!match) break
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      consumeBlock(block)
    }
    if (flushTail && buffer) {
      consumeBlock(buffer)
      buffer = ''
    }
  }
  const feed = chunk => {
    buffer += decoder.write(chunk)
    parseBuffer(false)
  }
  const end = () => {
    buffer += decoder.end()
    parseBuffer(true)
    finish('stop')
  }
  return { feed, end, finish }
}

function writeConvertedJsonAsStream(responseBody, target, model, res) {
  const converter = createStreamConverter('chat', target, model, res)
  converter.feed(Buffer.from(`data: ${responseBody}\n\ndata: [DONE]\n\n`))
  converter.end()
}

/**
 * Applies the client fingerprint chosen in the extension. `fetch()` in an
 * extension cannot set User-Agent, so direct requests are rewritten by
 * declarativeNetRequest; Router-forwarded requests are rewritten here instead.
 */
function applyClientIdentityHeaders(headers, identity, kind) {
  if (!identity || typeof identity !== 'object') return headers
  if (identity.stripSdkHeaders !== false) {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('x-stainless-') || lower.startsWith('x-sdk-') || lower.startsWith('x-browser-') || lower.startsWith('sec-ch-ua')) {
        delete headers[name]
      }
    }
  }
  if (typeof identity.userAgent === 'string' && identity.userAgent) headers['user-agent'] = identity.userAgent
  const extra = kind === 'messages'
    ? { ...(identity.headers || {}), ...(identity.messagesHeaders || {}) }
    : (identity.headers || {})
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || !value) continue
    const lower = name.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'content-length' || lower === 'host') continue
    headers[lower] = value
  }
  return headers
}

function stripHopByHopHeaders(headers) {
  const result = { ...headers }
  const connectionTokens = String(result.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  for (const name of [
    'host', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'te', 'trailer', 'content-length', 'authorization', 'x-api-key',
    'api-key', 'x-codexswitch-control-token', 'proxy-authorization', ...connectionTokens,
  ]) {
    delete result[name]
  }
  return result
}

function parseProxyUrl(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const proxy = new URL(text)
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error('Router proxy must use http or https')
  }
  if (!proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('Router proxy must be an http(s) URL without a path or query')
  }
  getProxyAuthorization(proxy)
  return proxy
}

function getProxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return undefined
  let username
  let password
  try {
    username = decodeURIComponent(proxy.username)
    password = decodeURIComponent(proxy.password)
  } catch {
    throw new Error('Router proxy credentials must be URL-encoded')
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

function getProxyTransport(proxy) {
  return proxy.protocol === 'https:' ? https : http
}

function getHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, '')
}

function requestWithProxy(upstream, options, body, proxy, onResponse, onError) {
  if (!proxy) {
    const transport = upstream.protocol === 'https:' ? https : http
    const request = transport.request(upstream, options, onResponse)
    request.setTimeout(300000, () => request.destroy(new Error('Upstream request timed out')))
    request.on('error', onError)
    if (body.length > 0) request.write(body)
    request.end()
    return request
  }

  if (upstream.protocol === 'http:') {
    const headers = {
      ...options.headers,
      host: upstream.host,
    }
    const proxyAuthorization = getProxyAuthorization(proxy)
    if (proxyAuthorization) headers['proxy-authorization'] = proxyAuthorization
    const request = getProxyTransport(proxy).request({
      protocol: proxy.protocol,
      hostname: getHostname(proxy),
      port: proxy.port || undefined,
      method: options.method,
      path: upstream.href,
      headers,
    }, onResponse)
    request.setTimeout(300000, () => request.destroy(new Error('Proxy request timed out')))
    request.on('error', onError)
    if (body.length > 0) request.write(body)
    request.end()
    return request
  }

  const proxyHeaders = { host: upstream.host }
  const proxyAuthorization = getProxyAuthorization(proxy)
  if (proxyAuthorization) proxyHeaders['proxy-authorization'] = proxyAuthorization
  const connectRequest = getProxyTransport(proxy).request({
    protocol: proxy.protocol,
    hostname: getHostname(proxy),
    port: proxy.port || undefined,
    method: 'CONNECT',
    path: `${upstream.hostname}:${upstream.port || 443}`,
    headers: proxyHeaders,
  })
  let connected = false
  let cancelled = false
  let activeRequest = connectRequest
  let tunnelSocket = null
  let secureSocket = null
  let failed = false
  const fail = error => {
    if (failed || cancelled) return
    failed = true
    onError(error)
  }
  connectRequest.on('connect', (response, socket, head) => {
    if (response.statusCode !== 200) {
      socket.destroy()
      fail(new Error(`Proxy CONNECT failed with status ${response.statusCode || 502}`))
      return
    }
    connected = true
    tunnelSocket = socket
    if (head.length > 0) socket.unshift(head)
    const upstreamHostname = getHostname(upstream)
    secureSocket = tls.connect({
      socket,
      servername: net.isIP(upstreamHostname) ? undefined : upstreamHostname,
      checkServerIdentity: (_serverName, certificate) => tls.checkServerIdentity(upstreamHostname, certificate),
    })
    secureSocket.once('error', fail)
    secureSocket.once('secureConnect', () => {
      if (cancelled) return secureSocket.destroy()
      const agent = new https.Agent({ keepAlive: false })
      agent.createConnection = () => secureSocket
      const request = https.request({
        protocol: 'https:',
        hostname: upstreamHostname,
        port: upstream.port || 443,
        method: options.method,
        path: `${upstream.pathname}${upstream.search}`,
        headers: options.headers,
        agent,
      }, onResponse)
      activeRequest = request
      request.setTimeout(300000, () => request.destroy(new Error('Proxy request timed out')))
      request.on('error', fail)
      if (body.length > 0) request.write(body)
      request.end()
    })
  })
  connectRequest.on('response', response => {
    response.resume()
    if (!connected) fail(new Error(`Proxy CONNECT failed with status ${response.statusCode || 502}`))
  })
  connectRequest.setTimeout(300000, () => connectRequest.destroy(new Error('Proxy CONNECT timed out')))
  connectRequest.on('error', fail)
  connectRequest.end()
  return {
    destroy() {
      cancelled = true
      activeRequest.destroy()
      if (secureSocket) secureSocket.destroy()
      else if (tunnelSocket) tunnelSocket.destroy()
    },
  }
}

function handleRequest(req, res, options = {}) {
  let state
  try {
    state = options.state || readState()
  } catch {
    return sendJson(res, 503, { error: 'Router configuration is unavailable' })
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    if (!safeEqual(req.headers['x-codexswitch-control-token'], state.localToken)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }
    return sendJson(res, 200, {
      service: 'codexswitch-router',
      running: state.enabled === true,
      port: state.port,
      pid: process.pid,
    })
  }

  if (state.enabled !== true) return sendJson(res, 503, { error: 'Router is disabled' })
  if (!safeEqual(getRequestToken(req), state.localToken)) return sendJson(res, 401, { error: 'Invalid local router token' })

  let incomingUrl
  let sourceKind
  try {
    incomingUrl = new URL(req.url, 'http://127.0.0.1')
    sourceKind = endpointKind(incomingUrl.pathname.replace(/^\/(?:openai|anthropic|deepseek)(?=\/)/, ''))
  } catch {
    return sendJson(res, 400, { error: 'Invalid request URL' })
  }
  if (!sourceKind) return sendJson(res, 404, { error: 'Unsupported API endpoint. Use /v1/chat/completions, /v1/responses, or /v1/messages.' })
  const namespace = incomingUrl.pathname.match(/^\/(openai|anthropic|deepseek)(?=\/)/)?.[1]
  const targetFormat = namespace || (sourceKind === 'messages' ? 'anthropic' : 'openai')
  const provider = state.providers ? state.providers[targetFormat] : state.provider
  if (!provider || !provider.baseUrl || (!provider.apiKey && !options.modelTest) || !provider.format) {
    return sendJson(res, 503, { error: 'No active provider is configured' })
  }
  if (!['openai', 'anthropic', 'deepseek'].includes(provider.format)) {
    return sendJson(res, 503, { error: 'Unsupported provider format' })
  }
  const conversionEnabled = (namespace === 'deepseek' && state.clients?.deepseek === true) || provider.formatConversionEnabled === true || options.routeByProvider === true
  const nativeSupported = supportedKinds(provider).includes(sourceKind)
  if (!options.modelTest && !conversionEnabled && !nativeSupported) {
    return sendJson(res, 400, {
      ...(sourceKind === 'messages' ? { type: 'error' } : {}),
      error: {
        type: 'invalid_request_error',
        message: 'Format conversion is disabled for this provider. Enable it to use this endpoint.',
      },
    })
  }
  const targetKind = options.modelTest && !options.routeByProvider || !conversionEnabled ? sourceKind : targetKindForProvider(provider, sourceKind)
  const requestId = crypto.randomBytes(8).toString('hex')
  const requestStartedAt = Date.now()
  const isCodexClient = /codex/i.test(String(req.headers['user-agent'] || ''))
  const logDiagnostic = (event, fields) => {
    if (!options.modelTest) logRequestDiagnostic(event, fields)
  }
  logDiagnostic('received', { requestId, client: isCodexClient ? 'codex' : 'other', sourceKind, targetKind })

  const chunks = []
  let size = 0
  let tooLarge = false
  req.on('data', chunk => {
    if (tooLarge) return
    size += chunk.length
    if (size > maxBodyBytes) {
      tooLarge = true
      res.shouldKeepAlive = false
      sendJson(res, 413, { error: 'Request body exceeds the router limit' })
      res.once('finish', () => req.destroy())
      return
    }
    chunks.push(chunk)
  })
  req.on('error', error => {
    if (!res.headersSent) sendJson(res, 400, { error: error.message })
  })
  req.on('end', () => {
    if (tooLarge || res.writableEnded) return

    const originalBody = Buffer.concat(chunks)
    const attemptedKinds = new Set()
    let clientWantsStream = false
    try { clientWantsStream = JSON.parse(originalBody.toString('utf8')).stream === true } catch {}
    let proxy
    try {
      proxy = parseProxyUrl(state.proxyUrl)
    } catch (error) {
      return sendJson(res, 503, { error: error.message })
    }

    const handleUpstreamResponse = (upstreamResponse, attemptKind, bufferedBody = null) => {
      const responseHeaders = { ...upstreamResponse.headers }
      for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', 'content-length']) delete responseHeaders[name]
      const statusCode = upstreamResponse.statusCode || 502
      const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase()
      if (!options.modelTest && statusCode >= 200 && statusCode < 300) setProtocolVerification(provider, attemptKind, true)
      const isUnsupportedEndpoint = isProtocolFailure(
        statusCode,
        bufferedBody === null ? '' : bufferedBody.toString('utf8'),
        provider,
        attemptKind,
      )
      if (!options.modelTest && isUnsupportedEndpoint) setProtocolVerification(provider, attemptKind, false)

      const alternateKind = provider.format === 'deepseek'
        ? supportedKinds(provider).find(kind => !attemptedKinds.has(kind) && getProtocolVerification(provider).get(kind) !== false)
        : options.modelTest ? 'chat' : (attemptKind === 'responses' ? 'chat' : 'responses')
      const isModelError = isUpstreamModelError(statusCode, bufferedBody === null ? '' : bufferedBody.toString('utf8'))
      const canFallback = !!alternateKind && (provider.format === 'deepseek'
        ? isUnsupportedEndpoint && !isModelError && (conversionEnabled || options.modelTest)
        : options.modelTest
        ? statusCode !== 200 && attemptKind !== 'chat'
        : statusCode >= 300
          && conversionEnabled
          && provider.format === 'openai'
          && (attemptKind === 'responses' || provider.apiType === 'both' || isUnsupportedEndpoint)
          && !isModelError
          && ['chat', 'responses'].includes(attemptKind)
          && getProtocolVerification(provider).get(alternateKind) !== false)
        && !attemptedKinds.has(alternateKind)
        && !res.headersSent
        && !res.writableEnded
      const errorMetadata = statusCode >= 400 && bufferedBody !== null
        ? getUpstreamErrorMetadata(bufferedBody.toString('utf8'))
        : {}
      logDiagnostic('upstream_response', {
        requestId,
        client: isCodexClient ? 'codex' : 'other',
        sourceKind,
        targetKind: attemptKind,
        statusCode,
        responseType: contentType.includes('text/event-stream') ? 'sse' : contentType.includes('json') ? 'json' : 'other',
        ...errorMetadata,
        protocolUnsupported: isUnsupportedEndpoint,
        converted: sourceKind !== attemptKind && statusCode >= 200 && statusCode < 300,
        fallback: canFallback,
        elapsedMs: Date.now() - requestStartedAt,
      })
      if (canFallback) {
        if (options.onFallback) options.onFallback({ sourceKind, statusCode, responseBody: bufferedBody?.toString('utf8') || '' })
        upstreamResponse.resume()
        issueAttempt(alternateKind)
        return
      }
      if (isUnsupportedEndpoint && !['both', 'all'].includes(provider.apiType) && ['openai', 'deepseek'].includes(provider.format)) {
        responseHeaders['x-codexswitch-protocol-validation'] = `${attemptKind}=unsupported`
      }
      if (statusCode >= 400) responseHeaders['x-codexswitch-error-source'] = 'upstream-http'

      const shouldConvert = sourceKind !== attemptKind && (options.modelTest ? statusCode === 200 : statusCode >= 200 && statusCode < 300)

      if (shouldConvert && contentType.includes('text/event-stream')) {
        for (const name of ['content-type', 'cache-control', 'x-accel-buffering', 'content-encoding']) delete responseHeaders[name]
        responseHeaders['content-type'] = 'text/event-stream; charset=utf-8'
        responseHeaders['cache-control'] = 'no-cache, no-transform'
        responseHeaders['x-accel-buffering'] = 'no'
        res.writeHead(statusCode, responseHeaders)
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        const converter = createStreamConverter(attemptKind, sourceKind, provider.model, res)
        upstreamResponse.on('data', chunk => converter.feed(chunk))
        upstreamResponse.on('end', () => {
          converter.end()
          if (!res.writableEnded) res.end()
        })
        upstreamResponse.on('error', error => res.destroy(error))
        return
      }

      if (shouldConvert) {
        delete responseHeaders['content-encoding']
        const responseChunks = []
        let responseSize = 0
        upstreamResponse.on('data', chunk => {
          responseSize += chunk.length
          if (responseSize > maxBodyBytes) {
            upstreamResponse.destroy(new Error('Upstream response body exceeds the router limit'))
            return
          }
          responseChunks.push(chunk)
        })
        upstreamResponse.on('end', () => {
          const responseBody = Buffer.concat(responseChunks)
          let convertedBody
          try {
            const converted = convertResponseValue(JSON.parse(responseBody.toString('utf8')), attemptKind, clientWantsStream ? 'chat' : sourceKind)
            if (clientWantsStream) {
              const choice = converted.choices[0]
              const message = choice.message
              converted.choices = [{
                ...choice,
                message: {
                  ...message,
                  content: responseTextFromChat(message),
                  tool_calls: (message.tool_calls || []).map((call, index) => ({ ...call, index })),
                },
              }]
            }
            convertedBody = JSON.stringify(converted)
          } catch {
            logDiagnostic('response_conversion_error', {
              requestId,
              sourceKind,
              targetKind: attemptKind,
              upstreamStatusCode: statusCode,
              statusCode: 502,
              elapsedMs: Date.now() - requestStartedAt,
            })
            res.setHeader('x-codexswitch-error-source', 'router-response-conversion')
            return sendJson(res, 502, {
              ...(sourceKind === 'messages' ? { type: 'error' } : {}),
              error: { type: 'api_error', message: `Could not convert ${attemptKind} response to ${sourceKind}: invalid upstream response` },
            })
          }
          if (clientWantsStream) {
            for (const name of ['content-type', 'cache-control', 'x-accel-buffering', 'content-encoding']) delete responseHeaders[name]
            responseHeaders['content-type'] = 'text/event-stream; charset=utf-8'
            responseHeaders['cache-control'] = 'no-cache, no-transform'
            responseHeaders['x-accel-buffering'] = 'no'
            res.writeHead(statusCode, responseHeaders)
            if (typeof res.flushHeaders === 'function') res.flushHeaders()
            writeConvertedJsonAsStream(convertedBody, sourceKind, provider.model, res)
            if (!res.writableEnded) res.end()
            return
          }
          responseHeaders['content-type'] = 'application/json; charset=utf-8'
          res.writeHead(statusCode, responseHeaders)
          res.end(convertedBody)
        })
        upstreamResponse.on('error', handleUpstreamError)
        return
      }

      res.writeHead(statusCode, responseHeaders)
      if (bufferedBody !== null) res.end(bufferedBody)
      else upstreamResponse.pipe(res)
    }
    const bufferErrorAndHandle = (upstreamResponse, attemptKind) => {
      const chunks = []
      let size = 0
      upstreamResponse.on('data', chunk => {
        size += chunk.length
        if (size <= maxBodyBytes) chunks.push(chunk)
      })
      upstreamResponse.on('end', () => {
        const body = Buffer.concat(chunks)
        handleUpstreamResponse(upstreamResponse, attemptKind, body)
      })
      upstreamResponse.on('error', handleUpstreamError)
    }
    const handleUpstreamError = error => {
      logDiagnostic('upstream_transport_error', {
        requestId,
        client: isCodexClient ? 'codex' : 'other',
        sourceKind,
        targetKind,
        errorCode: typeof error?.code === 'string' ? error.code.slice(0, 40) : 'unknown',
        elapsedMs: Date.now() - requestStartedAt,
      })
      if (!res.headersSent) {
        res.setHeader('x-codexswitch-error-source', 'router-upstream-transport')
        sendJson(res, 502, { error: `Upstream request failed: ${error.message}` })
      }
      else res.destroy(error)
    }
    let upstreamOperation
    const issueAttempt = kind => {
      attemptedKinds.add(kind)
      if (options.onAttempt) options.onAttempt({ sourceKind, targetKind: kind })
      let upstream
      try {
        upstream = resolveUpstream(provider.baseUrl, `${endpointPath(kind)}${incomingUrl.search}`)
      } catch (error) {
        return sendJson(res, 400, { error: error.message })
      }

      let body = originalBody
      if (String(req.headers['content-type'] || '').includes('application/json')) {
        try {
          body = replaceRequestModel(originalBody, sourceKind, kind, provider.model).body
        } catch (error) {
          return sendJson(res, 400, { error: `Could not convert ${sourceKind} request to ${kind}: ${error.message}` })
        }
      }

      const headers = stripHopByHopHeaders(req.headers)
      headers['accept-encoding'] = 'identity'
      // Entry-client disguise (Router-only, applied after format conversion):
      // keyed by the namespace the client used to reach us (openai=Codex,
      // anthropic=Claude Code, deepseek=DeepSeek Harness). It takes precedence
      // over the target-provider-format identity configured in the browser.
      const disguiseIdentity = namespace && state.clientDisguise && state.clientDisguise[namespace]
      const identity = disguiseIdentity || (state.clientIdentity && state.clientIdentity[provider.format]) || provider.clientIdentity
      applyClientIdentityHeaders(headers, identity, kind)
      logDiagnostic('client_identity', {
        requestId,
        entryClient: namespace || 'default',
        disguiseApplied: !!disguiseIdentity,
        userAgent: typeof identity?.userAgent === 'string' ? identity.userAgent.slice(0, 80) : undefined,
      })
      if (kind === 'messages') {
        if (provider.apiKey) headers['x-api-key'] = provider.apiKey
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
        if (!headers['anthropic-beta']) delete headers['anthropic-beta']
      } else {
        if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`
        delete headers['anthropic-version']
        delete headers['anthropic-beta']
      }
      if (body.length > 0) headers['content-length'] = String(body.length)
      upstreamOperation = requestWithProxy(
        upstream,
        { method: req.method, headers },
        body,
        proxy,
        response => (options.modelTest ? response.statusCode !== 200 : (response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300)
          ? bufferErrorAndHandle(response, kind)
          : handleUpstreamResponse(response, kind),
        handleUpstreamError,
      )
    }
    issueAttempt(targetKind)
    res.on('close', () => {
      if (!res.writableEnded && upstreamOperation) upstreamOperation.destroy()
    })
  })
}

function createRouterServer(options = {}) {
  const server = http.createServer((req, res) => handleRequest(req, res, options))
  server.requestTimeout = options.modelTest ? 60000 : 300000
  server.headersTimeout = 60000
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  return server
}

function requestModelTestEndpoint(port, token, kind, body, signal) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body))
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpointPath(kind),
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'user-agent': 'CodexSwitch-Model-Test',
        connection: 'close',
      },
      signal,
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBodyBytes) {
          response.destroy(new Error('Test response body exceeds the router limit'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, responseBody: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('Test response was interrupted')))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

function modelTestError(statusCode, responseBody) {
  try {
    const value = JSON.parse(responseBody)
    const error = typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message
    if (typeof error === 'string' && error) return error.slice(0, 2000)
  } catch {}
  return `HTTP ${statusCode}`
}

async function testModelViaRouter(provider, proxyUrl = '', targetFormat) {
  parseProxyUrl(proxyUrl)
  const state = { enabled: true, host: '127.0.0.1', localToken: crypto.randomBytes(32).toString('hex'), provider, proxyUrl }
  const nativeFailures = new Map()
  const upstreamKinds = new Map()
  const sockets = new Set()
  const server = createRouterServer({
    state,
    modelTest: true,
    routeByProvider: targetFormat !== undefined,
    onAttempt: attempt => upstreamKinds.set(attempt.sourceKind, attempt.targetKind),
    onFallback: failure => nativeFailures.set(failure.sourceKind, failure),
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60000)
  const endpoints = []
  const kinds = (targetFormat || provider.format) === 'deepseek' ? ['chat', 'responses', 'messages']
    : (targetFormat || provider.format) === 'anthropic' ? ['messages']
    : targetFormat === 'openai' || provider.apiType === 'both' ? ['chat', 'responses']
      : [provider.apiType === 'responses' ? 'responses' : 'chat']
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const port = server.address().port
    for (const kind of kinds) {
      const body = kind === 'responses'
        // Responses API requires max_output_tokens >= 16.
        ? { model: provider.model, input: [{ role: 'user', content: 'Hi' }], max_output_tokens: 16, stream: false }
        : { model: provider.model, messages: [{ role: 'user', content: kind === 'messages' ? [{ type: 'text', text: 'Hi' }] : 'Hi' }], max_tokens: kind === 'messages' ? 128 : 16, stream: false }
      let endpoint
      try {
        const result = await requestModelTestEndpoint(port, state.localToken, kind, body, controller.signal)
        endpoint = { label: kind, success: result.statusCode === 200, statusCode: result.statusCode, responseBody: result.responseBody.slice(0, 2000) }
        if (!endpoint.success) endpoint.error = modelTestError(result.statusCode, result.responseBody)
      } catch (error) {
        endpoint = { label: kind, success: false, statusCode: 0, error: controller.signal.aborted ? 'Timeout (60s)' : error.message }
      }
      const nativeFailure = nativeFailures.get(kind)
      const upstreamKind = upstreamKinds.get(kind)
      if (endpoint.success && upstreamKind && upstreamKind !== kind) endpoint.convertedFrom = upstreamKind
      if (nativeFailure) {
        endpoint.nativeStatusCode = nativeFailure.statusCode
        endpoint.nativeError = modelTestError(nativeFailure.statusCode, nativeFailure.responseBody)
        endpoint.nativeResponseBody = nativeFailure.responseBody.slice(0, 2000)
        if (!endpoint.success) endpoint.error = `Native ${kind} (${endpoint.nativeStatusCode}): ${endpoint.nativeError}; ${upstreamKind} fallback (${endpoint.statusCode}): ${endpoint.error}`
      }
      endpoints.push(endpoint)
    }
  } finally {
    clearTimeout(timeoutId)
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(() => resolve()))
  }
  const success = endpoints.some(endpoint => endpoint.success)
  const selected = endpoints.find(endpoint => endpoint.success) || endpoints[0]
  const kindLabels = { chat: 'Chat', responses: 'Responses', messages: 'Messages' }
  const message = endpoints.map(endpoint => `${endpoint.label}: ${endpoint.success ? (endpoint.convertedFrom ? `OK via ${kindLabels[endpoint.convertedFrom]}` : 'OK') : endpoint.error}`).join('; ')
  return { success, statusCode: selected.statusCode, message, error: success ? undefined : message, responseBody: selected.responseBody, endpoints }
}

if (require.main === module) {
  let server
  try {
    const state = readState()
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('Invalid router port')
    if (state.host !== '127.0.0.1') throw new Error('Router must bind to 127.0.0.1')
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 })
    try { fs.chmodSync(pidPath, 0o600) } catch {}
    server = createRouterServer()
    server.on('error', error => {
      console.error(`CodexSwitch Router error: ${error.message}`)
      process.exitCode = 1
    })
    server.listen(state.port, '127.0.0.1', () => {
      console.log(`CodexSwitch Router listening on 127.0.0.1:${state.port}`)
    })
  } catch (error) {
    console.error(`CodexSwitch Router failed to start: ${error.message}`)
    process.exitCode = 1
  }

  function shutdown() {
    if (server) server.close(() => process.exit(0))
    else process.exit(0)
    setTimeout(() => process.exit(0), 2000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

module.exports = { testModelViaRouter }
