// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import type { ApiType, ProviderFormat, TestResult } from '../src/types'

interface TestProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  format: ProviderFormat
  apiType: ApiType
  formatConversionEnabled?: boolean
}

interface UpstreamRequest {
  url: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

interface FixtureResponse {
  statusCode: number
  body: string | object
  headers?: http.OutgoingHttpHeaders
}

const hostScript = path.resolve(process.env.CODEXSWITCH_TEST_NATIVE_HOST || 'native_host/codex_config_host.cjs')
const temporaryHomes: string[] = []
const servers: http.Server[] = []
const children = new Set<ChildProcess>()

afterEach(async () => {
  for (const child of children) child.kill()
  children.clear()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-model-test-'))
  temporaryHomes.push(home)
  return home
}

function makeProvider(baseUrl: string, overrides: Partial<TestProvider> = {}): TestProvider {
  return { id: 'form-provider', name: 'Form Provider', baseUrl, apiKey: 'form-key', model: 'form-model', format: 'openai', apiType: 'chat', ...overrides }
}

function runHost(home: string, message: unknown) {
  const payload = Buffer.from(JSON.stringify(message))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length)
  return new Promise<{ success: boolean; error?: string; data?: TestResult }>((resolve, reject) => {
    const child = spawn(process.execPath, [hostScript], { env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeoutId = setTimeout(() => {
      child.kill()
      reject(new Error('Native model test did not finish within 8 seconds'))
    }, 8000)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => {
      clearTimeout(timeoutId)
      children.delete(child)
      reject(error)
    })
    child.on('close', status => {
      clearTimeout(timeoutId)
      children.delete(child)
      try {
        expect(status, Buffer.concat(stderr).toString()).toBe(0)
        const output = Buffer.concat(stdout)
        expect(output.length).toBeGreaterThanOrEqual(4)
        const responseLength = output.readUInt32LE(0)
        expect(output.length).toBe(responseLength + 4)
        expect(responseLength).toBeLessThan(1024 * 1024)
        resolve(JSON.parse(output.subarray(4).toString()))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(Buffer.concat([length, payload]))
  })
}

async function testModel(provider: TestProvider, home = makeHome(), proxyUrl = '', targetFormat?: ProviderFormat) {
  const result = await runHost(home, { action: 'testModelViaRouter', config: { provider, proxyUrl, ...(targetFormat ? { targetFormat } : {}) } })
  expect(result.success, result.error).toBe(true)
  expect(result.data).toBeDefined()
  return result.data as TestResult
}

async function makeUpstream(reply: (request: UpstreamRequest) => FixtureResponse) {
  const requests: UpstreamRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const recorded = { url: request.url || '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }
      requests.push(recorded)
      const result = reply(recorded)
      response.writeHead(result.statusCode, result.headers ?? { 'content-type': 'application/json' })
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(server)
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, requests }
}

function chatResponse(text = 'chat-reply') {
  return {
    id: 'chat-test', object: 'chat.completion', model: 'form-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }
}

function snapshotHome(home: string) {
  const files: Record<string, { mode: number; content?: string }> = {}
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      files[path.relative(home, filename)] = { mode: fs.statSync(filename).mode & 0o777, ...(entry.isFile() ? { content: fs.readFileSync(filename).toString('base64') } : {}) }
      if (entry.isDirectory()) visit(filename)
    }
  }
  visit(home)
  return files
}

describe('isolated model-test routing', () => {
  it.each(['chat', 'responses', 'both'] as const)('tests the converted Messages endpoint for an OpenAI %s Router entry', async apiType => {
    const home = makeHome()
    const nativeKind = apiType === 'responses' ? 'responses' : 'chat'
    const upstream = await makeUpstream(() => ({ statusCode: 200, body: nativeKind === 'chat' ? chatResponse() : {
      id: 'native-responses', object: 'response', model: 'form-model', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses-reply' }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    } }))
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType, formatConversionEnabled: true }), home, '', 'anthropic')

    expect(upstream.requests.map(request => request.url)).toEqual([nativeKind === 'chat' ? '/v1/chat/completions' : '/v1/responses'])
    expect(result).toMatchObject({ success: true, statusCode: 200, endpoints: [{ label: 'messages', success: true, statusCode: 200, convertedFrom: nativeKind }] })
    expect(result.endpoints).toHaveLength(1)
    expect(JSON.parse(result.responseBody || '')).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: nativeKind === 'chat' ? 'chat-reply' : 'responses-reply' }] })
    expect(result.endpoints?.[0]).not.toHaveProperty('nativeStatusCode')
    expect(snapshotHome(home)).toEqual({})
  })

  it('tests converted Chat and Responses endpoints for an Anthropic Router entry', async () => {
    const home = makeHome()
    const upstream = await makeUpstream(() => ({ statusCode: 200, body: {
      id: 'messages-test', type: 'message', role: 'assistant', model: 'form-model',
      content: [{ type: 'text', text: 'messages-reply' }], stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    } }))
    const result = await testModel(makeProvider(upstream.baseUrl, { format: 'anthropic', formatConversionEnabled: true }), home, '', 'openai')

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/messages', '/v1/messages'])
    expect(upstream.requests.every(request => request.headers['x-api-key'] === 'form-key' && request.headers.authorization === undefined)).toBe(true)
    expect(result.endpoints).toMatchObject([
      { label: 'chat', success: true, statusCode: 200, convertedFrom: 'messages' },
      { label: 'responses', success: true, statusCode: 200, convertedFrom: 'messages' },
    ])
    expect(result.endpoints).toHaveLength(2)
    expect(JSON.parse(result.endpoints?.[0].responseBody || '')).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'messages-reply' } }] })
    expect(JSON.parse(result.endpoints?.[1].responseBody || '')).toMatchObject({ object: 'response', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'messages-reply' }] }] })
    expect(snapshotHome(home)).toEqual({})
  })

  it('tests converted Responses through Chat without probing an unsupported native Responses endpoint', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/chat/completions'
      ? { statusCode: 200, body: chatResponse() }
      : { statusCode: 404, body: { error: { message: 'unsupported-native-endpoint' } } })
    const result = await testModel(makeProvider(upstream.baseUrl), makeHome(), '', 'openai')

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
    expect(result.endpoints).toMatchObject([
      { label: 'chat', success: true, statusCode: 200 },
      { label: 'responses', success: true, statusCode: 200, convertedFrom: 'chat' },
    ])
    expect(result.endpoints).toHaveLength(2)
    expect(result.endpoints?.[1]).not.toHaveProperty('nativeStatusCode')
    expect(JSON.parse(result.endpoints?.[1].responseBody || '')).toMatchObject({ object: 'response', output: [{ content: [{ type: 'output_text', text: 'chat-reply' }] }] })
  })

  it.each([undefined, false, true])('keeps model-test fallback independent of provider conversion=%s', async formatConversionEnabled => {
    const home = makeHome()
    const before = snapshotHome(home)
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 404, body: { error: { message: 'native-endpoint-unavailable' } } }
      : { statusCode: 200, body: chatResponse() })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses', formatConversionEnabled }), home)

    expect(result).toMatchObject({ success: true, statusCode: 200, endpoints: [{ label: 'responses', convertedFrom: 'chat', nativeStatusCode: 404 }] })
    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(JSON.parse(result.responseBody || '')).toMatchObject({ object: 'response', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'chat-reply' }] }] })
    expect(snapshotHome(home)).toEqual(before)
  })

  it.each([
    { label: 'chat', format: 'openai', apiType: 'chat', endpoint: '/v1/chat/completions' },
    { label: 'responses', format: 'openai', apiType: 'responses', endpoint: '/v1/responses' },
    { label: 'messages', format: 'anthropic', apiType: 'chat', endpoint: '/v1/messages' },
  ] as const)('keeps native $label responses unchanged when status is 200', async ({ label, format, apiType, endpoint }) => {
    const nativeResponse = { id: 'native-test', model: 'form-model', native: label }
    const upstream = await makeUpstream(() => ({ statusCode: 200, body: nativeResponse }))
    const result = await testModel(makeProvider(upstream.baseUrl, { format, apiType }))

    expect(upstream.requests.map(request => request.url)).toEqual([endpoint])
    expect(result).toMatchObject({ success: true, statusCode: 200, endpoints: [{ label, success: true, statusCode: 200 }] })
    expect(JSON.parse(result.responseBody || '')).toEqual(nativeResponse)
    expect(result.endpoints?.[0]).not.toHaveProperty('convertedFrom')
    expect(upstream.requests[0].body).toMatchObject({ model: 'form-model', stream: false })
    if (format === 'anthropic') {
      expect(upstream.requests[0].headers['x-api-key']).toBe('form-key')
      expect(upstream.requests[0].headers['anthropic-version']).toBe('2023-06-01')
      expect(upstream.requests[0].headers.authorization).toBeUndefined()
    } else {
      expect(upstream.requests[0].headers.authorization).toBe('Bearer form-key')
      expect(upstream.requests[0].headers['x-api-key']).toBeUndefined()
    }
  })

  it.each([201, 204, 302, 401, 403, 404, 422, 429, 502, 503])('falls back from native Responses status %i to Chat and converts the response', async statusCode => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode, body: { error: { message: 'native-responses-error' } } }
      : { statusCode: 200, body: chatResponse() })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(upstream.requests[0].body).toMatchObject({ input: [{ role: 'user', content: 'Hi' }], max_output_tokens: 16 })
    expect(upstream.requests[1].body).toMatchObject({ model: 'form-model', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 16, stream: false })
    expect(result.endpoints?.[0]).toMatchObject({ label: 'responses', success: true, statusCode: 200, convertedFrom: 'chat', nativeStatusCode: statusCode })
    expect(JSON.parse(result.responseBody || '')).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'chat-reply' }] }] })
    expect(result.endpoints?.[0].nativeResponseBody).toBe(statusCode === 204 ? '' : '{"error":{"message":"native-responses-error"}}')
  })

  it('converts a failed Messages request through Chat and returns an Anthropic response', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/messages'
      ? { statusCode: 422, body: { error: { message: 'native-messages-error' } } }
      : { statusCode: 200, body: chatResponse() })
    const result = await testModel(makeProvider(upstream.baseUrl, { format: 'anthropic' }))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/messages', '/v1/chat/completions'])
    expect(upstream.requests[1].body).toMatchObject({ model: 'form-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], max_tokens: 128, stream: false })
    expect(upstream.requests[1].headers.authorization).toBe('Bearer form-key')
    expect(upstream.requests[1].headers['x-api-key']).toBeUndefined()
    expect(upstream.requests[1].headers['anthropic-version']).toBeUndefined()
    expect(result.endpoints?.[0]).toMatchObject({ label: 'messages', convertedFrom: 'chat', nativeStatusCode: 422, nativeError: 'native-messages-error' })
    expect(JSON.parse(result.responseBody || '')).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'chat-reply' }], usage: { input_tokens: 3, output_tokens: 2 } })
  })

  it('tests both native interfaces independently, even when Chat fails', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/chat/completions'
      ? { statusCode: 401, body: { error: { message: 'chat-denied' } } }
      : { statusCode: 200, body: { id: 'native-responses', object: 'response', output: [] } })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'both' }))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/responses'])
    expect(result).toMatchObject({ success: true, statusCode: 200, endpoints: [{ label: 'chat', success: false, statusCode: 401 }, { label: 'responses', success: true, statusCode: 200 }] })
    expect(result.endpoints?.[1]).not.toHaveProperty('convertedFrom')
  })

  it('keeps native Chat while adding a converted Responses test for both', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 404, body: { error: { message: 'model not found' } } }
      : { statusCode: 200, body: chatResponse() })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'both' }))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/chat/completions'])
    expect(result.endpoints).toMatchObject([{ label: 'chat', success: true }, { label: 'responses', success: true, convertedFrom: 'chat', nativeStatusCode: 404 }])
  })

  it('does not reverse-fallback a failed Chat test to Responses', async () => {
    const upstream = await makeUpstream(() => ({ statusCode: 502, body: { error: { message: 'chat-failed' } } }))
    const result = await testModel(makeProvider(upstream.baseUrl))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/chat/completions'])
    expect(result).toMatchObject({ success: false, statusCode: 502, endpoints: [{ label: 'chat', success: false, error: 'chat-failed' }] })
  })

  it.each([201, 401, 429, 502])('stops after Chat fallback status %i and retains both failures', async statusCode => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 422, body: { error: { message: 'native-rejected' } } }
      : { statusCode, body: { error: { message: 'chat-rejected' } } })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }))

    expect(upstream.requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(result).toMatchObject({ success: false, statusCode, endpoints: [{ nativeStatusCode: 422, statusCode, success: false, nativeError: 'native-rejected' }] })
    expect(result.error).toContain('Native responses (422): native-rejected')
    expect(result.error).toContain(`chat fallback (${statusCode}): chat-rejected`)
    expect(result.endpoints?.[0]).not.toHaveProperty('convertedFrom')
  }, 10000)

  it('converts valid Chat JSON even when the content type is omitted', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 404, body: { error: 'unsupported' } }
      : { statusCode: 200, body: chatResponse(), headers: {} })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }))

    expect(result.success).toBe(true)
    expect(JSON.parse(result.responseBody || '')).toMatchObject({ object: 'response', status: 'completed' })
  })

  it('reports a conversion failure instead of returning an invalid successful Responses body', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 404, body: { error: 'unsupported' } }
      : { statusCode: 200, body: 'not-json' })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }))

    expect(result).toMatchObject({ success: false, statusCode: 502 })
    expect(result.error).toContain('Could not convert chat response to responses')
  })

  it.each(['openai', 'anthropic'] as const)('omits authentication for an empty %s key and does not create global router files', async format => {
    const home = makeHome()
    const upstream = await makeUpstream(() => ({ statusCode: 200, body: { native: true } }))
    const result = await testModel(makeProvider(upstream.baseUrl, { format, apiKey: '' }), home)

    expect(result.success).toBe(true)
    expect(upstream.requests[0].headers.authorization).toBeUndefined()
    expect(upstream.requests[0].headers['x-api-key']).toBeUndefined()
    expect(snapshotHome(home)).toEqual({})
  })

  it.each([false, true])('leaves existing clients and global router state untouched when enabled=%s', async enabled => {
    const home = makeHome()
    const files = {
      '.codex/config.toml': 'model_provider = "configured-provider"\nmodel = "configured-model"\n',
      '.codex/auth.json': '{"OPENAI_API_KEY":"configured-key"}',
      '.claude/settings.json': '{"env":{"ANTHROPIC_API_KEY":"configured-key"}}',
      '.codexswitch/router-state.json': JSON.stringify({ enabled, host: '127.0.0.1', port: 15721, localToken: 'configured-token', provider: makeProvider('http://configured.invalid/v1', { model: 'configured-model' }) }),
      '.codexswitch/router-token.json': '{"token":"configured-token"}',
      '.codexswitch/router-state.json.pid': '99999999',
      '.codexswitch/router-state.json.log': 'existing-router-log\n',
      '.codexswitch/router-backup/manifest.json': '{"files":[]}',
      '.codexswitch/router-backup/config.toml': 'existing-client-backup\n',
    }
    for (const [filename, content] of Object.entries(files)) {
      const target = path.join(home, filename)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      fs.writeFileSync(target, content, { mode: 0o600 })
    }
    const before = snapshotHome(home)
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 404, body: { error: 'unsupported' } }
      : { statusCode: 200, body: chatResponse() })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }), home)

    expect(result.success).toBe(true)
    expect(upstream.requests.every(request => request.body.model === 'form-model' && request.headers.authorization === 'Bearer form-key')).toBe(true)
    expect(snapshotHome(home)).toEqual(before)
  })

  it('uses the supplied proxy for both attempts without leaking proxy credentials into the request body', async () => {
    const proxy = await makeUpstream(request => request.url.endsWith('/responses')
      ? { statusCode: 404, body: { error: 'unsupported' } }
      : { statusCode: 200, body: chatResponse() })
    const proxyUrl = proxy.baseUrl.replace('http://', 'http://proxy-user:proxy-pass@').replace(/\/v1$/, '')
    const result = await testModel(makeProvider('http://provider.invalid/v1', { apiType: 'responses' }), makeHome(), proxyUrl)

    expect(result.success).toBe(true)
    expect(proxy.requests.map(request => request.url)).toEqual(['http://provider.invalid/v1/responses', 'http://provider.invalid/v1/chat/completions'])
    expect(proxy.requests.every(request => request.headers['proxy-authorization'] === `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`)).toBe(true)
    expect(JSON.stringify(proxy.requests.map(request => request.body))).not.toContain('proxy-pass')
  })

  it('bounds the Native Host frame while retaining native and converted response previews', async () => {
    const upstream = await makeUpstream(request => request.url === '/v1/responses'
      ? { statusCode: 422, body: { error: { message: 'native-error' }, detail: 'detail'.repeat(1000) } }
      : { statusCode: 200, body: chatResponse('reply'.repeat(1000)) })
    const result = await testModel(makeProvider(upstream.baseUrl, { apiType: 'responses' }))

    expect(result.success).toBe(true)
    expect(result.responseBody).toHaveLength(2000)
    expect(result.endpoints?.[0].responseBody).toHaveLength(2000)
    expect(result.endpoints?.[0].nativeResponseBody).toHaveLength(2000)
    expect(result.endpoints?.[0].nativeError).toBe('native-error')
  })

  it('rejects a blank model before issuing requests or changing configuration', async () => {
    const home = makeHome()
    const upstream = await makeUpstream(() => ({ statusCode: 200, body: chatResponse() }))
    const result = await runHost(home, { action: 'testModelViaRouter', config: { provider: makeProvider(upstream.baseUrl, { model: ' ' }) } })

    expect(result).toEqual({ success: false, error: 'Select a model before testing' })
    expect(upstream.requests).toEqual([])
    expect(snapshotHome(home)).toEqual({})
  })
})
