// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'

const hostScript = process.env.CODEXSWITCH_TEST_NATIVE_HOST || path.resolve('native_host/codex_config_host.cjs')
const temporaryHomes: string[] = []
const servers: http.Server[] = []
const secureServers: https.Server[] = []
const tunnelSockets = new Set<net.Socket>()
const testCertPath = path.resolve('tests/fixtures/router-test-cert.pem')
const testKeyPath = path.resolve('tests/fixtures/router-test-key.pem')

afterEach(async () => {
  for (const socket of tunnelSockets) socket.destroy()
  tunnelSockets.clear()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const server of secureServers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const home of temporaryHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const legacyFixtures = new Map<string, Array<{ file: string; content: Buffer | null; mode: number }>>()
async function runHostAsync(home: string, message: any) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length)
  const child = spawn(process.execPath, [hostScript], {
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return await new Promise<any>((resolve, reject) => {
    const output: Buffer[] = []
    let stderr = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native host timed out')) }, 10000)
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) { reject(new Error(stderr || `Native host exited with ${code}`)); return }
      try {
        const response = Buffer.concat(output)
        resolve(JSON.parse(response.subarray(4, 4 + response.readUInt32LE(0)).toString('utf8')))
      } catch (error) { reject(error) }
    })
    child.stdin.end(Buffer.concat([length, payload]))
  })
}

function runHost(home: string, message: any, extraEnv: NodeJS.ProcessEnv = {}) {
  const stateFile = path.join(home, '.codexswitch/router-state.json')
  if (legacyFixtures.has(home) && message.action === 'disableRouter') {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.clients = {}
    fs.writeFileSync(stateFile, JSON.stringify(state))
  }
  if (legacyFixtures.has(home) && message.action === 'setRouterProvider' && !message.config.targetFormat) {
    for (const targetFormat of ['openai', 'anthropic', 'deepseek']) runHost(home, { ...message, config: { ...message.config, targetFormat } }, extraEnv)
  }
  if (message?.action === 'enableRouterLegacy') {
    const files = ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json']
    legacyFixtures.set(home, files.map(file => ({ file: path.join(home, file), content: fs.existsSync(path.join(home, file)) ? fs.readFileSync(path.join(home, file)) : null, mode: fs.existsSync(path.join(home, file)) ? fs.statSync(path.join(home, file)).mode & 0o777 : 0o600 })))
    const config = message.config || {}
    const started = runHost(home, { action: 'enableRouter', config: { port: config.port, proxyUrl: config.proxyUrl } }, extraEnv)
    if (!started.success) return started
    const provider = config.provider
    if (provider) for (const format of ['openai', 'anthropic']) {
      const result = runHost(home, { action: 'setClientRouting', config: { format, enabled: true, provider: { ...provider, formatConversionEnabled: true } } }, extraEnv)
      if (!result.success) return result
    }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    state.providers = config.providers || { openai: provider, anthropic: provider, deepseek: provider }
    fs.writeFileSync(stateFile, JSON.stringify(state))
    return started
  }
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length, 0)
  const result = spawnSync(process.execPath, [hostScript], {
    input: Buffer.concat([length, payload]),
    env: { ...process.env, ...extraEnv, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh') },
    encoding: 'buffer',
    timeout: 10000,
  })
  expect(result.status, result.stderr?.toString()).toBe(0)
  const responseLength = result.stdout.readUInt32LE(0)
  if (legacyFixtures.has(home) && message.action === 'disableRouter') {
    for (const snapshot of legacyFixtures.get(home)!) {
      if (snapshot.content) { fs.mkdirSync(path.dirname(snapshot.file), { recursive: true }); fs.writeFileSync(snapshot.file, snapshot.content); fs.chmodSync(snapshot.file, snapshot.mode) }
      else fs.rmSync(snapshot.file, { force: true })
    }
    legacyFixtures.delete(home)
  }
  return JSON.parse(result.stdout.subarray(4, 4 + responseLength).toString('utf8')) as {
    success: boolean
    error?: string
    data?: Record<string, unknown>
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  servers.push(server)
  return (server.address() as { port: number }).port
}

async function listenSecure(server: https.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  secureServers.push(server)
  return (server.address() as { port: number }).port
}

function makeUpstream() {
  const requests: Array<{ url: string; authorization?: string; apiKey?: string; anthropicVersion?: string; body: unknown }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        url: req.url || '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
        anthropicVersion: req.headers['anthropic-version'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  return { server, requests }
}

function makeProtocolUpstream(format: 'chat' | 'messages' | 'responses' | 'both', streamMode: 'text' | 'tool' = 'text') {
  const requests: Array<{ url: string; body: any; authorization?: string; apiKey?: string; anthropicVersion?: string }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ url: req.url || '', body, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined, anthropicVersion: req.headers['anthropic-version'] as string | undefined })
      if (format === 'responses' || (format === 'both' && req.url === '/v1/responses')) {
        const output = body.tools?.length
          ? [{ id: 'fc_lookup', type: 'function_call', status: 'completed', call_id: 'call_lookup', name: 'lookup', arguments: '{"city":"Tokyo"}' }]
          : [{ id: 'msg_text', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'converted', annotations: [] }] }]
        const response = { id: 'resp_upstream', object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } })}\n\n`)
        if (body.tools?.length) {
          res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...output[0], arguments: '', status: 'in_progress' } })}\n\n`)
          res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":"Tokyo"}' })}\n\n`)
        } else {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'converted' })}\n\n`)
        }
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
        return
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (format === 'chat' || format === 'both') {
          if (body.tools?.length) {
            if (body.tools.length > 1) {
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-multi-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call-weather', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] })}\n\n`)
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-multi-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call-time', type: 'function', function: { name: 'get_time', arguments: '' } }] }, finish_reason: null }] })}\n\n`)
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-multi-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"city":"Tokyo"}' } }, { index: 2, function: { arguments: '{"timezone":"Asia/Tokyo"}' } }] }, finish_reason: null }] })}\n\n`)
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-multi-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-multi-tool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\n`)
              res.end('data: [DONE]\n\n')
              return
            }
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-tool-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call-stream', type: 'function', function: { name: 'lookup', arguments: '' } }] }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-tool-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{\"city\":\"Tokyo\"}' } }] }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-tool-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
          } else {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'streamed' }, finish_reason: null }] })}\n\n`)
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
          }
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`)
          res.end('data: [DONE]\n\n')
        } else if (streamMode === 'tool') {
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-tool-stream', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`)
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_stream', name: 'lookup', input: {} } })}\n\n`)
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Tokyo"}' } })}\n\n`)
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } })}\n\n`)
          res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        } else {
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-stream', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`)
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } })}\n\n`)
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`)
          res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
        }
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (format === 'chat' || format === 'both') {
        if (body.tools?.length) {
          res.end(JSON.stringify({ id: 'chatcmpl-tool-json', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-json', type: 'function', function: { name: 'lookup', arguments: '{"city":"Tokyo"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
        } else {
          res.end(JSON.stringify({ id: 'chatcmpl-json', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'converted' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
        }
      } else {
        if (body.tools?.length) {
          res.end(JSON.stringify({ id: 'msg-tool-json', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: 'toolu-json', name: 'lookup', input: { city: 'Tokyo' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 } }))
        } else {
          res.end(JSON.stringify({ id: 'msg-json', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'converted' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } }))
        }
      }
    })
  })
  return { server, requests }
}

function makeHttpProxy() {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(`${req.method || 'GET'} ${req.url || ''} ${req.headers['proxy-authorization'] || ''}`)
    const target = new URL(req.url || '')
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-authorization']
    const upstreamRequest = http.request(target, { method: req.method, headers }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstreamRequest.on('error', error => {
      res.writeHead(502)
      res.end(error.message)
    })
    req.pipe(upstreamRequest)
  })
  return { server, requests }
}

function callRouter(port: number, token: string, body: object, requestPath = '/v1/chat/completions', agent: http.Agent | false = http.globalAgent) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      agent,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }))
    })
    request.on('error', reject)
    request.end(JSON.stringify(body))
  })
}

function parseSseEvents(body: string): Array<{ event: string; data: any }> {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const lines = block.split(/\r?\n/)
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || ''
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) }
  })
}

async function getFreePort(): Promise<number> {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  servers.splice(servers.indexOf(server), 1)
  return port
}

describe('native host local API router', () => {
  it('applies entry-client disguise after conversion and lets the provider-format identity fall back', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-disguise-live-'))
    temporaryHomes.push(home)
    const headers: http.IncomingHttpHeaders[] = []
    const upstream = await listen(http.createServer((req, res) => {
      req.resume()
      headers.push(req.headers)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    }))
    const port = await getFreePort()
    const identity = (userAgent: string) => ({ userAgent, headers: {}, messagesHeaders: {}, stripSdkHeaders: true })
    const byProvider = { openai: identity('identity/by-provider') }
    const provider = { name: 'test', format: 'openai', apiType: 'chat', baseUrl: `http://127.0.0.1:${upstream}/v1`, apiKey: 'test-key', model: 'test', clientIdentity: identity('fallback/incorrect') }
    expect(runHost(home, { action: 'enableRouter', config: {
      port, providers: { openai: provider }, clientIdentity: byProvider,
      clientDisguise: { openai: identity('disguise/openai') },
    } }).success).toBe(true)
    const stateFile = path.join(home, '.codexswitch/router-state.json')
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const pid = fs.readFileSync(`${stateFile}.pid`, 'utf8')
    const body = { model: 'test', messages: [{ role: 'user', content: 'hello' }] }
    try {
      // Request through the Codex entry namespace -> disguise wins.
      expect((await callRouter(port, readState().localToken, body, '/openai/v1/chat/completions')).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('disguise/openai')
      // Request without a namespace -> falls back to the provider-format identity.
      expect((await callRouter(port, readState().localToken, body, '/v1/chat/completions')).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('identity/by-provider')
      // Live disguise update takes effect without restart and persists in state.
      const nextDisguise = { openai: identity('disguise/updated') }
      expect(runHost(home, { action: 'setClientDisguise', config: { clientDisguise: nextDisguise } }).success).toBe(true)
      expect(readState().clientDisguise).toEqual(nextDisguise)
      expect((await callRouter(port, readState().localToken, body, '/openai/v1/chat/completions')).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('disguise/updated')
      expect(fs.readFileSync(`${stateFile}.pid`, 'utf8')).toBe(pid)
      // Off-equivalent: clearing the map restores the fallback identity.
      expect(runHost(home, { action: 'setClientDisguise', config: { clientDisguise: {} } }).success).toBe(true)
      expect((await callRouter(port, readState().localToken, body, '/openai/v1/chat/completions')).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('identity/by-provider')
    } finally {
      runHost(home, { action: 'disableRouter' })
    }
  })

  it('applies consecutive identity updates including off without restarting or losing other formats', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-identity-live-'))
    temporaryHomes.push(home)
    const headers: http.IncomingHttpHeaders[] = []
    const upstream = await listen(http.createServer((req, res) => {
      req.resume()
      headers.push(req.headers)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    }))
    const port = await getFreePort()
    const identity = (userAgent: string) => ({ userAgent, headers: {}, messagesHeaders: {}, stripSdkHeaders: true })
    const initial = { openai: identity('identity/first'), anthropic: identity('identity/anthropic') }
    const provider = { name: 'test', format: 'openai', apiType: 'chat', baseUrl: `http://127.0.0.1:${upstream}/v1`, apiKey: 'test-key', model: 'test', clientIdentity: identity('fallback/incorrect') }
    expect(runHost(home, { action: 'enableRouter', config: { port, provider, clientIdentity: initial } }).success).toBe(true)
    const stateFile = path.join(home, '.codexswitch/router-state.json')
    const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const pid = fs.readFileSync(`${stateFile}.pid`, 'utf8')
    let stage = 'initial identity'
    const request = async () => {
      try {
        // The restart assertion must not reuse a socket from the terminated test router.
        return await callRouter(port, readState().localToken, { model: 'test', messages: [{ role: 'user', content: 'hello' }] }, '/v1/chat/completions', false)
      } catch (error) {
        throw new Error(`${stage}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      expect((await request()).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('identity/first')
      for (const openai of [identity('identity/second'), { headers: {}, messagesHeaders: {}, stripSdkHeaders: false }, identity('identity/third')]) {
        stage = 'userAgent' in openai ? openai.userAgent : 'off'
        const clientIdentity = { ...initial, openai }
        expect(runHost(home, { action: 'setClientIdentity', config: { clientIdentity } }).success).toBe(true)
        expect(readState().clientIdentity).toEqual(clientIdentity)
        expect((await request()).status).toBe(200)
        expect(headers.at(-1)?.['user-agent']).toBe('userAgent' in openai ? openai.userAgent : undefined)
        expect(fs.readFileSync(`${stateFile}.pid`, 'utf8')).toBe(pid)
      }
      expect(runHost(home, { action: 'disableRouter' }).success).toBe(true)
      stage = 're-enabled identity'
      expect(runHost(home, { action: 'enableRouter', config: { port, provider, clientIdentity: initial } }).success).toBe(true)
      expect((await request()).status).toBe(200)
      expect(headers.at(-1)?.['user-agent']).toBe('identity/first')
    } finally {
      runHost(home, { action: 'disableRouter' })
    }
  })

  it('releases router state locks after a failed client change', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-routing-lock-failure-'))
    temporaryHomes.push(home)
    const result = runHost(home, { action: 'setClientRouting', config: { format: 'unsupported' } })
    expect(result).toMatchObject({ success: false, error: 'Unsupported client format' })
    const stateDir = path.join(home, '.codexswitch')
    expect(fs.readdirSync(stateDir).filter(file => file.includes('.lock'))).toEqual([])
    expect(runHost(home, { action: 'routerStatus' })).toMatchObject({ success: true, data: { enabled: false, running: false } })
    expect(fs.readdirSync(stateDir).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('reclaims a dead native host lock before reading router state', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-routing-stale-lock-'))
    temporaryHomes.push(home)
    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(exited.status).toBe(0)
    const lockPath = path.join(home, '.codexswitch/router-state.json.lock')
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: exited.pid }))
    const results = await Promise.all(Array.from({ length: 3 }, () => runHostAsync(home, { action: 'routerStatus' })))
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ success: true, data: { enabled: false, running: false } })))
    expect(fs.readdirSync(path.dirname(lockPath)).filter(file => file.includes('.lock'))).toEqual([])
  })

  it('preserves other client files, switches, and upstreams through all three routing toggles', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-routing-isolation-'))
    temporaryHomes.push(home)
    const port = await getFreePort()
    const formats = ['openai', 'anthropic', 'deepseek'] as const
    const providers = Object.fromEntries(formats.map(format => [format, {
      id: format, name: format, format, apiType: 'chat', baseUrl: `https://${format}.example.test/v1`, apiKey: `${format}-key`, model: `${format}-model`,
    }]))
    const files = {
      openai: ['.codex/config.toml', '.codex/auth.json'],
      anthropic: ['.claude/settings.json'],
      deepseek: ['.dsh/profiles/desktop/cordis.patch.yml', '.dsh/.credentials.yaml'],
    }
    const readFiles = (format: typeof formats[number]) => files[format].map(file => fs.readFileSync(path.join(home, file)))
    const readState = () => JSON.parse(fs.readFileSync(path.join(home, '.codexswitch/router-state.json'), 'utf8'))
    expect(runHost(home, { action: 'enableRouter', config: { port, providers } }).success).toBe(true)
    try {
      for (const format of formats) expect(runHost(home, { action: 'setClientRouting', config: { format, enabled: false, provider: providers[format] } }).success).toBe(true)
      for (const format of formats) {
        for (const enabled of [true, false, true]) {
          const before = readState()
          const otherFiles = formats.filter(other => other !== format).map(other => [other, readFiles(other)] as const)
          const result = runHost(home, { action: 'setClientRouting', config: { format, enabled, provider: providers[format] } })
          expect(result.success, result.error).toBe(true)
          const after = readState()
          expect(after.clients[format]).toBe(enabled)
          for (const [other, content] of otherFiles) {
            expect(readFiles(other)).toEqual(content)
            expect(after.clients[other]).toBe(before.clients[other])
            expect(after.providers[other]).toEqual(before.providers[other])
          }
        }
      }
    } finally {
      for (const format of formats) runHost(home, { action: 'setClientRouting', config: { format, enabled: false, provider: providers[format] } })
      expect(runHost(home, { action: 'disableRouter' }).success).toBe(true)
    }
  })

  it('does not lose other client routes when native host processes toggle concurrently', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-routing-concurrent-'))
    temporaryHomes.push(home)
    let firstHealth!: () => void
    const healthStarted = new Promise<void>(resolve => { firstHealth = resolve })
    let healthCount = 0
    const health = http.createServer((_req, res) => {
      healthCount++
      const respond = () => { res.end(JSON.stringify({ service: 'codexswitch-router', running: true })) }
      if (healthCount === 1) { firstHealth(); setTimeout(respond, 250) }
      else respond()
    })
    const port = await listen(health)
    const stateFile = path.join(home, '.codexswitch/router-state.json')
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const deepseek = { id: 'd', format: 'deepseek' }
    fs.writeFileSync(stateFile, JSON.stringify({ enabled: true, port, localToken: 'a'.repeat(64), clients: { deepseek: true }, providers: { deepseek } }))
    const toggle = (format: string) => runHostAsync(home, { action: 'setClientRouting', config: {
      format, enabled: true, provider: { id: format, name: format, format, baseUrl: `https://${format}.example.test/v1`, apiKey: `${format}-key`, model: `${format}-model` },
    } })
    const openai = toggle('openai')
    await healthStarted
    const anthropic = toggle('anthropic')
    const results = await Promise.all([openai, anthropic])
    expect(results.map(result => result.success)).toEqual([true, true])
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    expect(state.clients).toEqual({ openai: true, anthropic: true, deepseek: true })
    expect(state.providers.openai?.id).toBe('openai')
    expect(state.providers.anthropic?.id).toBe('anthropic')
    expect(state.providers.deepseek).toEqual(deepseek)
  })

  it('starts without providers, changes only one client, and refuses stop until direct restoration', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-client-switch-'))
    temporaryHomes.push(home)
    const port = await getFreePort()
    const claude = path.join(home, '.claude/settings.json')
    fs.mkdirSync(path.dirname(claude), { recursive: true })
    fs.writeFileSync(claude, '{"theme":"dark"}')
    const provider = { id: 'native', name: 'Native', format: 'openai', apiType: 'chat', baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'm' }
    expect(runHost(home, { action: 'enableRouter', config: { port } }).success).toBe(true)
    try {
      expect(fs.existsSync(path.join(home, '.codex/auth.json'))).toBe(false)
      expect(fs.readFileSync(claude, 'utf8')).toBe('{"theme":"dark"}')
      expect(runHost(home, { action: 'setClientRouting', config: { format: 'openai', enabled: true, provider } }).success).toBe(true)
      expect(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')).toContain(`/openai/v1`)
      expect(fs.readFileSync(claude, 'utf8')).toBe('{"theme":"dark"}')
      expect(fs.existsSync(path.join(home, '.dsh'))).toBe(false)
      expect(runHost(home, { action: 'disableRouter' }).success).toBe(false)
      expect(runHost(home, { action: 'routerStatus' }).data?.running).toBe(true)
      expect(runHost(home, { action: 'setClientRouting', config: { format: 'openai', enabled: false, provider } }).success).toBe(true)
      expect(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8')).toContain('https://example.test/v1')
    } finally {
      runHost(home, { action: 'setClientRouting', config: { format: 'openai', enabled: false, provider } })
      expect(runHost(home, { action: 'disableRouter' }).success).toBe(true)
    }
  })

  it('routes DeepSeek messages and responses to its namespace independent of other clients', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-deepseek-namespace-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('chat')
    const upstreamPort = await listen(upstream.server)
    const port = await getFreePort()
    const provider = { id: 'dsh', name: 'DSH', format: 'deepseek', apiType: 'chat', selectedApiType: 'messages', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'deepseek-key', model: 'deepseek-model' }
    expect(runHost(home, { action: 'enableRouter', config: { port } }).success).toBe(true)
    try {
      expect(runHost(home, { action: 'setClientRouting', config: { format: 'deepseek', enabled: true, provider } }).success).toBe(true)
      const state = JSON.parse(fs.readFileSync(path.join(home, '.codexswitch/router-state.json'), 'utf8'))
      for (const endpoint of ['messages', 'responses']) {
        const response = await callRouter(port, state.localToken, { model: 'router', input: 'hello', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 }, `/deepseek/v1/${endpoint}`)
        expect(response.status, response.body).toBe(200)
      }
      expect((await callRouter(port, state.localToken, { messages: [] }, '/anthropic/v1/messages')).status).toBe(503)
      expect(fs.readFileSync(path.join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8')).toContain(`/deepseek`)
    } finally {
      runHost(home, { action: 'setClientRouting', config: { format: 'deepseek', enabled: false, provider } })
      expect(runHost(home, { action: 'disableRouter' }).success).toBe(true)
    }
  })
  it('removes a stale Anthropic API key when syncing Claude with an auth token', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-claude-auth-token-'))
    temporaryHomes.push(home)
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      env: { ANTHROPIC_API_KEY: 'stale-key', ANTHROPIC_AUTH_TOKEN: 'stale-token', KEEP_SETTING: 'keep' },
    }))
    const result = runHost(home, { action: 'updateClaudeConfig', config: {
      ANTHROPIC_BASE_URL: 'https://upstream.example', ANTHROPIC_AUTH_TOKEN: 'new-token', model: 'selected-model',
    } })
    expect(result.success, result.error).toBe(true)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      model: 'selected-model',
      env: {
        ANTHROPIC_BASE_URL: 'https://upstream.example', ANTHROPIC_AUTH_TOKEN: 'new-token',
        ANTHROPIC_MODEL: 'selected-model', KEEP_SETTING: 'keep',
      },
    })
  })

  it.each([
    { config: { ANTHROPIC_BASE_URL: 'https://selected.example' }, baseUrl: 'https://selected.example', model: 'existing-model' },
    { config: { model: 'selected-model' }, baseUrl: 'https://existing.example', model: 'selected-model' },
    { config: { ANTHROPIC_BASE_URL: 'https://selected.example', model: 'selected-model' }, baseUrl: 'https://selected.example', model: 'selected-model' },
  ])('removes a stale Anthropic API key without replacing the auth token when syncing $config', ({ config, baseUrl, model }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-claude-preserve-token-'))
    temporaryHomes.push(home)
    const settingsPath = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      model: 'existing-model',
      env: {
        ANTHROPIC_API_KEY: 'stale-key', ANTHROPIC_AUTH_TOKEN: 'existing-token',
        ANTHROPIC_BASE_URL: 'https://existing.example', ANTHROPIC_MODEL: 'existing-model', KEEP_SETTING: 'keep',
      },
    }))
    const result = runHost(home, { action: 'updateClaudeConfig', config })
    expect(result.success, result.error).toBe(true)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      model,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'existing-token', ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_MODEL: model, KEEP_SETTING: 'keep',
      },
    })
  })

  it.each(([undefined, false] as const).flatMap(formatConversionEnabled => [
    { format: 'openai', apiType: 'chat', formatConversionEnabled },
    { format: 'openai', apiType: 'responses', formatConversionEnabled },
    { format: 'openai', apiType: 'both', formatConversionEnabled },
    { format: 'anthropic', apiType: 'chat', formatConversionEnabled },
  ]))('only serves declared native protocols with $format/$apiType conversion=$formatConversionEnabled', async ({ format, apiType, formatConversionEnabled }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-native-only-'))
    temporaryHomes.push(home)
    const target = format === 'anthropic' ? 'messages' : apiType === 'responses' ? 'responses' : apiType === 'both' ? 'both' : 'chat'
    const nativeKinds = format === 'anthropic' ? ['messages'] : apiType === 'both' ? ['chat', 'responses'] : [apiType]
    const upstream = makeProtocolUpstream(target)
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'native-only', name: 'Native only', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'upstream-key', model: 'upstream-model', format, apiType, formatConversionEnabled,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      for (const source of ['chat', 'responses', 'messages']) {
        for (const stream of [false, true]) {
          const requestBody = {
            model: 'client-model', stream, metadata: { client: source },
            ...(source === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }),
            ...(source === 'messages' ? { max_tokens: 32 } : {}),
          }
          const requestCount = upstream.requests.length
          const endpoint = source === 'chat' ? '/v1/chat/completions' : `/v1/${source}`
          const result = await callRouter(routerPort, token, requestBody, endpoint)
          if (!nativeKinds.includes(source)) {
            expect(result.status).toBe(400)
            expect(JSON.parse(result.body)).toMatchObject({ error: { type: 'invalid_request_error', message: expect.stringContaining('Format conversion is disabled') } })
            expect(upstream.requests).toHaveLength(requestCount)
          } else {
            expect(result.status).toBe(200)
            expect(upstream.requests).toHaveLength(requestCount + 1)
            expect(upstream.requests.at(-1)).toMatchObject({ url: endpoint, body: { ...requestBody, model: 'upstream-model' } })
            expect(result.headers['content-type']).toContain(stream ? 'text/event-stream' : 'application/json')
          }
        }
      }
    } finally {
      if (enabled) expect(runHost(home, { action: 'disableRouter', config: {} }).success).toBe(true)
    }
  })

  it.each([undefined, false])('preserves native Responses failures without fallback when conversion=%s', async formatConversionEnabled => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-no-fallback-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const nativeError = JSON.stringify({ error: { type: 'invalid_request_error', message: 'Responses endpoint is not supported' } })
    const upstream = http.createServer((request, response) => {
      requests.push(request.url || '')
      request.resume()
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(nativeError)
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'native-error', name: 'Native error', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'upstream-key', model: 'upstream-model', format: 'openai', apiType: 'both', formatConversionEnabled,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      for (const stream of [false, true]) {
        const result = await callRouter(routerPort, token, { model: 'client-model', input: 'hello', stream }, '/v1/responses')
        expect(result.status).toBe(404)
        expect(result.body).toBe(nativeError)
        expect(result.headers['x-codexswitch-error-source']).toBe('upstream-http')
      }
      expect(requests).toEqual(['/v1/responses', '/v1/responses'])
    } finally {
      if (enabled) expect(runHost(home, { action: 'disableRouter', config: {} }).success).toBe(true)
    }
  })

  it.each([
    { format: 'openai', apiType: 'chat' },
    { format: 'openai', apiType: 'responses' },
    { format: 'openai', apiType: 'both' },
    { format: 'anthropic', apiType: 'chat' },
  ])('applies $format/$apiType conversion toggles without restarting the router', async ({ format, apiType }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-conversion-toggle-'))
    temporaryHomes.push(home)
    const target = format === 'anthropic' ? 'messages' : apiType === 'responses' ? 'responses' : apiType === 'both' ? 'both' : 'chat'
    const upstream = makeProtocolUpstream(target)
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    const provider = {
      id: 'toggle', name: 'Toggle', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-key', model: 'upstream-model', format, apiType,
    }
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: { ...provider, formatConversionEnabled: false } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const source = format === 'anthropic' ? 'responses' : 'messages'
      const body = { model: 'client-model', stream: false, ...(source === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }) }
      for (const formatConversionEnabled of [false, true, false]) {
        const updated = runHost(home, { action: 'setRouterProvider', config: { provider: { ...provider, formatConversionEnabled } } })
        expect(updated.success, updated.error).toBe(true)
        expect(updated.data?.pid).toBe(enable.data?.pid)
        const requestCount = upstream.requests.length
        const result = await callRouter(routerPort, token, body, `/v1/${source}`)
        expect(result.status).toBe(formatConversionEnabled ? 200 : 400)
        expect(upstream.requests).toHaveLength(requestCount + (formatConversionEnabled ? 1 : 0))
        if (formatConversionEnabled) {
          expect(JSON.parse(result.body)).toMatchObject(source === 'responses'
            ? { object: 'response', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'converted' }] }] }
            : { type: 'message', content: [{ type: 'text', text: 'converted' }] })
        }
      }
    } finally {
      if (enabled) expect(runHost(home, { action: 'disableRouter', config: {} }).success).toBe(true)
    }
  })

  it.each([
    { format: 'openai', apiType: 'chat' },
    { format: 'openai', apiType: 'responses' },
    { format: 'openai', apiType: 'both' },
    { format: 'anthropic', apiType: 'chat' },
  ])('serves Codex, Claude Code and plugin protocols with $format/$apiType', async ({ format, apiType }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-protocol-matrix-'))
    temporaryHomes.push(home)
    const target = format === 'anthropic' ? 'messages' : apiType === 'responses' ? 'responses' : 'chat'
    const upstream = makeProtocolUpstream(apiType === 'both' ? 'both' : target, 'tool')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'matrix', name: 'Matrix', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'upstream-key', model: 'upstream-model', format, apiType, formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      for (const source of ['chat', 'responses', 'messages']) {
        for (const stream of [false, true]) {
          const body = source === 'responses'
            ? { input: 'use lookup', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }], tool_choice: 'auto' }
            : { messages: [{ role: 'user', content: 'use lookup' }], tools: source === 'messages'
              ? [{ name: 'lookup', input_schema: { type: 'object' } }]
              : [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }], tool_choice: source === 'messages' ? { type: 'auto' } : 'auto' }
          const requestBody = { model: 'client', ...body, stream, ...(source === 'messages' ? { max_tokens: 32 } : {}), metadata: { client: source } }
          const result = await callRouter(routerPort, token, requestBody, source === 'chat' ? '/v1/chat/completions' : `/v1/${source}`)
          expect(result.status).toBe(200)
          const request = upstream.requests.at(-1)!
          const expectedTarget = apiType === 'both' && source === 'responses' ? 'responses' : target
          expect(request.url).toBe(expectedTarget === 'chat' ? '/v1/chat/completions' : `/v1/${expectedTarget}`)
          expect(request.body.model).toBe('upstream-model')
          expect(request.body.metadata).toEqual({ client: source })
          if (expectedTarget === source) expect(request.body).toEqual({ ...requestBody, model: 'upstream-model' })
          if (expectedTarget === 'messages') {
            expect(request.apiKey).toBe('upstream-key')
            expect(request.body.max_tokens).toBeGreaterThan(0)
            expect(request.body.tool_choice).toEqual({ type: 'auto' })
            expect(request.body.tools).toEqual([{ name: 'lookup', input_schema: { type: 'object' } }])
          } else {
            expect(request.authorization).toBe('Bearer upstream-key')
            expect(request.body.tool_choice).toBe('auto')
            expect(request.body.tools).toEqual(expectedTarget === 'responses'
              ? [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }]
              : [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }])
          }
          if (!stream) {
            const response = JSON.parse(result.body)
            if (source === 'responses') expect(response).toMatchObject({ object: 'response', output: [{ type: 'function_call', name: 'lookup', arguments: '{"city":"Tokyo"}' }] })
            else if (source === 'messages') expect(response).toMatchObject({ type: 'message', content: [{ type: 'tool_use', name: 'lookup', input: { city: 'Tokyo' } }], stop_reason: 'tool_use' })
            else expect(response).toMatchObject({ object: 'chat.completion', choices: [{ message: { tool_calls: [{ function: { name: 'lookup', arguments: '{"city":"Tokyo"}' } }] }, finish_reason: 'tool_calls' }] })
          } else {
            const events = parseSseEvents(result.body).map(item => item.data)
            if (source === 'responses') expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [{ type: 'function_call', name: 'lookup', arguments: '{"city":"Tokyo"}' }] } })
            else if (source === 'messages') {
              expect(events.find(event => event.type === 'content_block_start')).toMatchObject({ content_block: { type: 'tool_use', name: 'lookup' } })
              expect(events.find(event => event.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'tool_use' } })
              expect(events.at(-1).type).toBe('message_stop')
            } else {
              expect(events.find(event => event.choices?.[0]?.delta?.tool_calls)).toMatchObject({ choices: [{ delta: { tool_calls: [{ function: { name: 'lookup' } }] } }] })
              expect(events.find(event => event.choices?.[0]?.finish_reason)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] })
              expect(events.at(-1)).toBe('[DONE]')
            }
          }
        }
      }
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('uses apiType as the declared protocol, validates it, then converts a fallback result for Codex', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-api-type-'))
    temporaryHomes.push(home)
    const requests: Array<{ url: string; body: any }> = []
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push({ url: req.url || '', body })
        if (req.url === '/v1/responses') {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'The /v1/responses endpoint does not exist' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'chatcmpl-fallback', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'works in Codex' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'api-type-both', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'upstream-model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const response = await callRouter(routerPort, token, { model: 'client-model', input: 'hello', stream: false }, '/v1/responses')
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ object: 'response', output_text: 'works in Codex', status: 'completed' })
      expect(requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/chat/completions'])
      expect(requests[1].body).toMatchObject({ model: 'upstream-model', messages: [{ role: 'user', content: 'hello' }] })

      const next = await callRouter(routerPort, token, { model: 'client-model', input: 'again' }, '/v1/responses')
      expect(next.status).toBe(200)
      expect(requests[2].url).toBe('/v1/chat/completions')
      const messages = await callRouter(routerPort, token, {
        model: 'client-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'message request' }] }],
      }, '/v1/messages')
      expect(messages.status).toBe(200)
      expect(JSON.parse(messages.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'works in Codex' }] })
      expect(requests[3].url).toBe('/v1/chat/completions')
      expect(requests[3].body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'message request' }] }])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each([
    { responseType: 'json', stream: false },
    { responseType: 'json', stream: true },
    { responseType: 'sse', stream: true },
  ])('returns only the final Responses wire response after a free-rail 404 with $responseType and stream=$stream', async ({ responseType, stream }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-final-response-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const nativeError = { error: { type: 'model_not_available', code: 404, message: 'model "deepseek-v4-flash-0731:free" was not found. The free rail only accepts /v1/chat/completions, /v1/messages; /v1/responses does not serve it.' } }
    const upstream = http.createServer((req, res) => {
      requests.push(req.url || '')
      req.resume()
      req.on('end', () => {
        if (req.url === '/v1/responses') {
          res.writeHead(404, { 'content-type': 'application/json', 'x-native-only': 'rejected' })
          res.end(JSON.stringify(nativeError))
          return
        }
        const choice = responseType === 'sse'
          ? { index: 0, delta: { content: 'final Chat reply' }, finish_reason: 'stop' }
          : { index: 0, message: { role: 'assistant', content: 'final Chat reply' }, finish_reason: 'stop' }
        const response = { id: 'chatcmpl-free-rail', model: 'deepseek-v4-flash-0731:free', choices: [choice] }
        res.writeHead(200, { 'content-type': responseType === 'sse' ? 'text/event-stream' : 'application/json' })
        res.end(responseType === 'sse' ? `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n` : JSON.stringify(response))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'free-rail', name: 'Free rail', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'deepseek-v4-flash-0731:free', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const response = await callRouter(routerPort, token, { input: 'hello', stream }, '/v1/responses')
      expect(response.status).toBe(200)
      expect(response.headers['x-native-only']).toBeUndefined()
      expect(response.headers['x-codexswitch-error-source']).toBeUndefined()
      expect(response.body).not.toContain('model_not_available')
      expect(response.body).not.toContain('Native responses')
      expect(response.body).not.toContain(nativeError.error.message)
      if (stream) {
        expect(response.headers['content-type']).toContain('text/event-stream')
        const events = parseSseEvents(response.body)
        expect(events.filter(item => item.event === 'response.completed')).toHaveLength(1)
        expect(events.some(item => item.event === 'error' || item.event === 'response.failed')).toBe(false)
        expect(events.at(-1)?.data.response).toMatchObject({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'final Chat reply' }] }] })
      } else {
        expect(JSON.parse(response.body)).toMatchObject({ object: 'response', status: 'completed', error: null, output_text: 'final Chat reply' })
      }
      expect(requests).toEqual(['/v1/responses', '/v1/chat/completions'])
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('returns only the final Chat error when a free-rail 404 fallback also fails', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-final-error-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const chatError = { error: { type: 'rate_limit_error', message: 'Final Chat rate limit' } }
    const upstream = http.createServer((req, res) => {
      requests.push(req.url || '')
      req.resume()
      req.on('end', () => {
        if (req.url === '/v1/responses') {
          res.writeHead(404, { 'content-type': 'application/json', 'x-native-only': 'rejected' })
          res.end(JSON.stringify({ error: { type: 'model_not_available', message: 'Native endpoint is not available on the free rail' } }))
          return
        }
        res.writeHead(429, { 'content-type': 'application/json', 'x-final-only': 'chat' })
        res.end(JSON.stringify(chatError))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'final-error', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const response = await callRouter(routerPort, token, { input: 'hello', stream: true }, '/v1/responses')
      expect(response.status).toBe(429)
      expect(JSON.parse(response.body)).toEqual(chatError)
      expect(response.headers['x-native-only']).toBeUndefined()
      expect(response.headers['x-final-only']).toBe('chat')
      expect(response.headers['x-codexswitch-error-source']).toBe('upstream-http')
      expect(requests).toEqual(['/v1/responses', '/v1/chat/completions'])
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each([
    { endpoint: '/v1/responses', stream: false },
    { endpoint: '/v1/responses', stream: true },
    { endpoint: '/v1/messages', stream: false },
    { endpoint: '/v1/messages', stream: true },
  ])('rejects invalid converted JSON before sending success headers for $endpoint with stream=$stream', async ({ endpoint, stream }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-invalid-conversion-'))
    temporaryHomes.push(home)
    const invalidResponses = [
      'private-invalid-payload',
      '{"error":{"message":"private-invalid-payload"}}{"choices":[{"message":{"role":"assistant","content":"reply"}}]}',
      '{"error":{"message":"private-invalid-payload"}}',
      '{}',
      'null',
      '[]',
      '{"choices":[]}',
      '{"choices":[{"delta":{"content":"not a complete response"}}]}',
      '{"choices":[{"message":[]}]}',
    ]
    let replyIndex = 0
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(invalidResponses[replyIndex++])
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'invalid-conversion', name: 'Chat', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'chat', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      for (const invalidResponse of invalidResponses) {
        const body = endpoint === '/v1/responses' ? { input: 'hello', stream } : { messages: [{ role: 'user', content: 'hello' }], stream }
        const response = await callRouter(routerPort, token, body, endpoint)
        expect(response.status, invalidResponse).toBe(502)
        expect(response.headers['content-type']).toContain('application/json')
        expect(response.headers['x-codexswitch-error-source']).toBe('router-response-conversion')
        expect(JSON.parse(response.body)).toMatchObject({ error: { type: 'api_error', message: expect.stringContaining('Could not convert chat response') } })
        expect(response.body).not.toContain('private-invalid-payload')
        expect(response.body).not.toContain('response.completed')
        expect(response.body).not.toContain('data:')
        if (endpoint === '/v1/messages') expect(JSON.parse(response.body).type).toBe('error')
      }
      expect(replyIndex).toBe(invalidResponses.length)
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each(['/v1/responses', '/v1/messages'])('converts successful JSON regardless of its content type for %s', async endpoint => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-json-content-type-'))
    temporaryHomes.push(home)
    const headers = [{}, { 'content-type': 'text/plain' }]
    let replyIndex = 0
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, headers[replyIndex++])
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'final Chat reply' }, finish_reason: 'stop' }] }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'content-type', name: 'Chat', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'chat', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      for (const responseHeaders of headers) {
        const body = endpoint === '/v1/responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }
        const response = await callRouter(routerPort, token, body, endpoint)
        expect(response.status, JSON.stringify(responseHeaders)).toBe(200)
        expect(response.headers['content-type']).toContain('application/json')
        expect(JSON.parse(response.body)).toMatchObject(endpoint === '/v1/responses'
          ? { object: 'response', status: 'completed', output_text: 'final Chat reply' }
          : { type: 'message', content: [{ type: 'text', text: 'final Chat reply' }] })
      }
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each([
    { source: 'chat', target: 'responses', format: 'openai', apiType: 'chat' },
    { source: 'chat', target: 'messages', format: 'openai', apiType: 'chat' },
    { source: 'messages', target: 'chat', format: 'anthropic', apiType: 'chat' },
    { source: 'messages', target: 'responses', format: 'anthropic', apiType: 'chat' },
    { source: 'responses', target: 'chat', format: 'openai', apiType: 'responses' },
    { source: 'responses', target: 'messages', format: 'openai', apiType: 'responses' },
  ])('emits complete $target SSE when $source returns a single JSON response', async ({ source, target, format, apiType }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-json-as-sse-'))
    temporaryHomes.push(home)
    const replies: Record<string, object> = {
      chat: { choices: [{ message: { role: 'assistant', content: 'final reply', tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"city":"Tokyo"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      messages: { id: 'msg_json', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'final reply' }, { type: 'tool_use', id: 'call_lookup', name: 'lookup', input: { city: 'Tokyo' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 2 } },
      responses: { id: 'resp_json', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final reply' }] }, { type: 'function_call', call_id: 'call_lookup', name: 'lookup', arguments: '{"city":"Tokyo"}' }], usage: { input_tokens: 3, output_tokens: 2 } },
    }
    const upstream = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(replies[source]))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'json-as-sse', name: source, baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format, apiType, formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const body = target === 'responses' ? { input: 'hello', stream: true } : { messages: [{ role: 'user', content: 'hello' }], stream: true }
      const response = await callRouter(routerPort, token, body, target === 'chat' ? '/v1/chat/completions' : `/v1/${target}`)
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toContain('text/event-stream')
      expect(response.body).toContain('final reply')
      expect(response.body).toContain('lookup')
      const events = parseSseEvents(response.body)
      expect(events.at(-1)?.event || events.at(-1)?.data).toBe(target === 'responses' ? 'response.completed' : target === 'messages' ? 'message_stop' : '[DONE]')
      if (target === 'responses') {
        expect(events.at(-1)?.data.response).toMatchObject({ output: [{ type: 'message' }, { type: 'function_call', name: 'lookup', arguments: '{"city":"Tokyo"}' }], usage: { input_tokens: 3, output_tokens: 2 } })
      }
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('does not fallback for model errors', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-api-type-strict-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const upstream = http.createServer((req, res) => {
      requests.push(req.url || '')
      req.resume()
      req.on('end', () => {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'model not found' } }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'api-type-strict', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'missing-model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const response = await callRouter(routerPort, token, { model: 'client-model', input: 'hello' }, '/v1/responses')
      expect(response.status).toBe(404)
      expect(JSON.parse(response.body).error.code).toBe('model_not_found')
      expect(requests).toEqual(['/v1/responses'])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each([
    { endpoint: '/v1/responses', stream: false },
    { endpoint: '/v1/responses', stream: true },
    { endpoint: '/v1/chat/completions', stream: false },
    { endpoint: '/v1/messages', stream: false },
    { endpoint: '/v1/messages', stream: true },
  ])('falls back from a gateway error on a single declared responses apiType for $endpoint with stream=$stream', async ({ endpoint, stream }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-api-type-single-fallback-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requests.push(req.url || '')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (req.url === '/v1/responses') {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'openai_error' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-single-fallback',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'single fallback' }, finish_reason: 'stop' }],
        }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'api-type-single-fallback', name: 'Responses only', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'upstream-model', format: 'openai', apiType: 'responses', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const requestBody = endpoint === '/v1/responses'
        ? { model: 'client-model', input: 'hello', stream }
        : { model: 'client-model', messages: [{ role: 'user', content: 'hello' }], stream }
      const response = await callRouter(routerPort, token, requestBody, endpoint)
      expect(response.status).toBe(200)
      if (stream) {
        expect(response.headers['content-type']).toContain('text/event-stream')
        const events = parseSseEvents(response.body).map(event => event.data)
        if (endpoint === '/v1/responses') {
          expect(events.at(-1)).toMatchObject({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'single fallback' }] }],
            },
          })
        } else {
          expect(events).toContainEqual(expect.objectContaining({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'single fallback' } }))
          expect(events.at(-1)).toMatchObject({ type: 'message_stop' })
        }
      } else if (endpoint === '/v1/responses') {
        expect(JSON.parse(response.body)).toMatchObject({ object: 'response', output_text: 'single fallback', status: 'completed' })
      } else if (endpoint === '/v1/messages') {
        expect(JSON.parse(response.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'single fallback' }], stop_reason: 'end_turn' })
      } else {
        expect(JSON.parse(response.body)).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'single fallback' }, finish_reason: 'stop' }] })
      }
      expect(requests).toEqual(['/v1/responses', '/v1/chat/completions'])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each([429, 502, 503])('does not mark Responses unsupported after a transient %s even when Chat succeeded', async statusCode => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-api-type-non2xx-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    let responsesAttempts = 0
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requests.push(req.url || '')
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (req.url === '/v1/responses') {
          responsesAttempts += 1
          if (responsesAttempts === 1) {
            res.writeHead(statusCode, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Responses endpoint unavailable' } }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ id: 'resp-recovered', object: 'response', model: body.model, status: 'completed', output_text: 'native recovered', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native recovered' }] }] }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'chatcmpl-ok', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'chat fallback' }, finish_reason: 'stop' }] }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'api-type-non2xx', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const validation = await callRouter(routerPort, token, { model: 'client', messages: [{ role: 'user', content: 'validate chat' }] })
      expect(validation.status).toBe(200)
      const response = await callRouter(routerPort, token, { model: 'client', input: 'convert to responses' }, '/v1/responses')
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ object: 'response', output_text: 'chat fallback' })
      const recovered = await callRouter(routerPort, token, { model: 'client', input: 'retry native responses' }, '/v1/responses')
      expect(recovered.status).toBe(200)
      expect(JSON.parse(recovered.body)).toMatchObject({ id: 'resp-recovered', object: 'response', output_text: 'native recovered' })
      expect(requests).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/chat/completions', '/v1/responses'])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('falls back from a Responses 422 without forwarding built-in tools to Chat', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-web-search-fallback-'))
    temporaryHomes.push(home)
    const requests: Array<{ url: string; body: any }> = []
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push({ url: req.url || '', body })
        if (req.url === '/v1/responses') {
          res.writeHead(422, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'tools[14]: unknown variant `web_search`, expected `web_search_20250305` or `web_search_20260209`' } }))
          return
        }
        expect(req.url).toBe('/v1/chat/completions')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-web-search-fallback',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'fallback succeeded' }, finish_reason: 'stop' }],
        }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'web-search-fallback', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const response = await callRouter(routerPort, token, {
        model: 'client',
        input: 'search the web',
        tools: [
          { type: 'web_search' },
          { type: 'web_search_20250305', name: 'web_search' },
          { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
        ],
      }, '/v1/responses')

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ object: 'response', output_text: 'fallback succeeded' })
      expect(requests.map(request => request.url)).toEqual(['/v1/responses', '/v1/chat/completions'])
      expect(requests[0].body.tools).toEqual([
        { type: 'web_search' },
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      ])
      expect(requests[1].body.tools).toEqual([
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } },
      ])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('tries each protocol once when both endpoints return errors', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-both-errors-'))
    temporaryHomes.push(home)
    const requests: string[] = []
    const upstream = http.createServer((req, res) => {
      requests.push(req.url || '')
      req.resume()
      req.on('end', () => {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'openai_error', message: 'upstream unavailable' } }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider: {
        id: 'api-type-both-errors', name: 'Both', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'key', model: 'model', format: 'openai', apiType: 'both', formatConversionEnabled: true,
      } } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const response = await callRouter(routerPort, token, { model: 'client', input: 'hello' }, '/v1/responses')

      expect(response.status).toBe(502)
      expect(response.headers['x-codexswitch-error-source']).toBe('upstream-http')
      expect(JSON.parse(response.body)).toEqual({ error: { type: 'openai_error', message: 'upstream unavailable' } })
      expect(requests).toEqual(['/v1/responses', '/v1/chat/completions'])
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each(['enableRouterLegacy', 'setRouterProvider'])('%s points both clients to the router for an Anthropic provider and restores originals', async action => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-client-config-'))
    temporaryHomes.push(home)
    const codexDir = path.join(home, '.codex')
    const claudeDir = path.join(home, '.claude')
    fs.mkdirSync(codexDir, { recursive: true })
    fs.mkdirSync(claudeDir, { recursive: true })
    const configPath = path.join(codexDir, 'config.toml')
    const authPath = path.join(codexDir, 'auth.json')
    const settingsPath = path.join(claudeDir, 'settings.json')
    const originalConfig = 'model_provider = "native"\nmodel = "native-model"\nmodel_reasoning_effort = "high"\n\n[model_providers.native]\nname = "Native"\nbase_url = "https://native.example/v1"\n'
    const originalAuth = JSON.stringify({ OPENAI_API_KEY: 'native-codex-key', other: true })
    const originalClaude = JSON.stringify({
      model: 'native-claude-model',
      env: {
        ANTHROPIC_BASE_URL: 'https://native.example', ANTHROPIC_MODEL: 'native-env-model',
        ANTHROPIC_API_KEY: 'native-claude-key', ANTHROPIC_AUTH_TOKEN: 'native-claude-token', KEEP_SETTING: 'keep',
      },
      theme: 'dark',
    })
    const originalFiles = [[configPath, originalConfig], [authPath, originalAuth], [settingsPath, originalClaude]]
    for (const [filePath, content] of originalFiles) fs.writeFileSync(filePath, content)
    const upstream = makeProtocolUpstream('messages')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    const provider = {
      id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: 'native-upstream-key', model: 'native-upstream-model', format: 'anthropic', formatConversionEnabled: true,
    }
    let enabled = false
    try {
      if (action === 'setRouterProvider') {
        const initial = runHost(home, {
          action: 'enableRouterLegacy',
          config: { port: routerPort, provider: { ...provider, id: 'openai', format: 'openai', apiType: 'chat' } },
        })
        expect(initial.success, initial.error).toBe(true)
        enabled = true
      }
      const result = runHost(home, { action, config: { port: routerPort, provider } })
      expect(result.success, result.error).toBe(true)
      enabled = true
      const state = JSON.parse(fs.readFileSync(path.join(home, '.codexswitch', 'router-state.json'), 'utf8'))
      expect(state.providers.anthropic).toMatchObject(provider)
      const token = state.localToken as string
      expect(token).toMatch(/^[a-f\d]{64}$/)
      expect(token).not.toBe(provider.apiKey)
      const config = fs.readFileSync(configPath, 'utf8')
      expect(config).toContain('model_provider = "OpenAI"')
      expect(config).toContain('model = "router"')
      expect(config).toContain(`base_url = "http://127.0.0.1:${routerPort}/openai/v1"`)
      expect(config).toContain('wire_api = "responses"')
      expect(config).toContain('model_reasoning_effort = "high"')
      expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({ OPENAI_API_KEY: token, other: true })
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
        model: 'router',
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${routerPort}/anthropic`, ANTHROPIC_MODEL: 'router',
          ANTHROPIC_AUTH_TOKEN: token, KEEP_SETTING: 'keep',
        },
        theme: 'dark',
      })
      const codexResponse = await callRouter(routerPort, token, { model: 'router', input: 'hello' }, '/v1/responses')
      const claudeResponse = await callRouter(routerPort, token, {
        model: 'router', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }],
      }, '/v1/messages')
      expect(codexResponse.status).toBe(200)
      expect(JSON.parse(codexResponse.body).object).toBe('response')
      expect(claudeResponse.status).toBe(200)
      expect(JSON.parse(claudeResponse.body).type).toBe('message')
      expect(upstream.requests).toHaveLength(2)
      for (const request of upstream.requests) {
        expect(request).toMatchObject({ url: '/v1/messages', apiKey: provider.apiKey, body: { model: provider.model } })
      }
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
      for (const [filePath, content] of originalFiles) expect(fs.readFileSync(filePath, 'utf8')).toBe(content)
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each(['auth.json', 'settings.json'])('switches only the route without touching client configs when %s is invalid', async invalidFile => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-config-rollback-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('chat')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    const provider = {
      id: 'original', name: 'Original', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'original-upstream-key', model: 'original-upstream-model', format: 'openai', formatConversionEnabled: true,
    }
    let enabled = false
    try {
      const enable = runHost(home, { action: 'enableRouterLegacy', config: { port: routerPort, provider } })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const statePath = path.join(home, '.codexswitch', 'router-state.json')
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const configPath = path.join(home, '.codex', 'config.toml')
      const authPath = path.join(home, '.codex', 'auth.json')
      const settingsPath = path.join(home, '.claude', 'settings.json')
      fs.writeFileSync(configPath, 'model_provider = "native"\nmodel = "native-model"\n')
      fs.writeFileSync(authPath, invalidFile === 'auth.json' ? '{invalid' : '{"OPENAI_API_KEY":"native-key"}')
      fs.writeFileSync(settingsPath, invalidFile === 'settings.json' ? '{invalid' : '{"model":"native-model"}')
      const snapshots = [configPath, authPath, settingsPath].map(filePath => ({
        filePath, content: fs.readFileSync(filePath, 'utf8'), mode: fs.statSync(filePath).mode & 0o777,
      }))
      const result = runHost(home, {
        action: 'setRouterProvider', config: { targetFormat: 'openai', provider: { ...provider, id: 'next', model: 'next-model' } },
      })
      expect(result.success, result.error).toBe(true)
      expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).providers.openai.model).toBe('next-model')
      for (const snapshot of snapshots) {
        expect(fs.readFileSync(snapshot.filePath, 'utf8')).toBe(snapshot.content)
        expect(fs.statSync(snapshot.filePath).mode & 0o777).toBe(snapshot.mode)
      }
      const response = await callRouter(routerPort, state.localToken, { model: 'router' })
      expect(response.status).toBe(200)
      expect(upstream.requests[0]).toMatchObject({ url: '/v1/chat/completions', body: { model: 'next-model' } })
      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
      for (const snapshot of snapshots) expect(fs.existsSync(snapshot.filePath)).toBe(false)
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('switches OpenAI and Anthropic routes independently without rewriting client files', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-independent-'))
    temporaryHomes.push(home)
    const openai = makeProtocolUpstream('responses')
    const anthropic = makeProtocolUpstream('messages')
    const openaiPort = await listen(openai.server)
    const anthropicPort = await listen(anthropic.server)
    const port = await getFreePort()
    const first = { id: 'openai', name: 'OpenAI', format: 'openai', apiType: 'responses', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, apiKey: 'openai-key', model: 'first-model', formatConversionEnabled: true }
    const second = { id: 'anthropic', name: 'Anthropic', format: 'anthropic', baseUrl: `http://127.0.0.1:${anthropicPort}`, apiKey: 'anthropic-key', model: 'second-model', formatConversionEnabled: true }
    try {
      const enabled = runHost(home, { action: 'enableRouterLegacy', config: { port, provider: first, providers: { openai: first, anthropic: second } } })
      expect(enabled.success, enabled.error).toBe(true)
      const files = ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json'].map(file => path.join(home, file))
      const snapshots = files.map(file => fs.readFileSync(file, 'utf8'))
      const state = JSON.parse(fs.readFileSync(path.join(home, '.codexswitch/router-state.json'), 'utf8'))
      const checkRoutes = async (openaiModel: string, anthropicModel: string) => {
        expect((await callRouter(port, state.localToken, { model: 'router', input: 'hello' }, '/v1/responses')).status).toBe(200)
        expect((await callRouter(port, state.localToken, { model: 'router', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }, '/v1/messages')).status).toBe(200)
        expect(openai.requests.at(-1)?.body.model).toBe(openaiModel)
        expect(anthropic.requests.at(-1)?.body.model).toBe(anthropicModel)
      }
      await checkRoutes('first-model', 'second-model')
      expect(runHost(home, { action: 'setRouterProvider', config: { targetFormat: 'openai', provider: { ...first, model: 'new-openai' } } }).success).toBe(true)
      await checkRoutes('new-openai', 'second-model')
      expect(runHost(home, { action: 'setRouterProvider', config: { targetFormat: 'anthropic', provider: { ...second, model: 'new-anthropic' } } }).success).toBe(true)
      await checkRoutes('new-openai', 'new-anthropic')
      expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(snapshots)
    } finally {
      runHost(home, { action: 'disableRouter' })
    }
  })

  it('routes and switches providers with stable client config, then restores backups', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-'))
    temporaryHomes.push(home)
    const codexDir = path.join(home, '.codex')
    const claudeDir = path.join(home, '.claude')
    fs.mkdirSync(codexDir, { recursive: true })
    fs.mkdirSync(claudeDir, { recursive: true })
    const originalConfig = 'model_provider = "OpenAI"\nmodel = "gpt-original"\n\n[model_providers.OpenAI]\nname = "OpenAI"\nbase_url = "https://original.example/v1"\n\n[model_providers.router]\nname = "Previous Router"\nbase_url = "https://previous.example/v1"\nenv_key = "OLD_ROUTER_KEY"\nexperimental_bearer_token = "stale-token"\n'
    const originalAuth = '{\n  "OPENAI_API_KEY": "original-key",\n  "other": true\n}\n'
    const originalClaude = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://original.example"\n  },\n  "theme": "dark"\n}\n'
    fs.writeFileSync(path.join(codexDir, 'config.toml'), originalConfig)
    fs.writeFileSync(path.join(codexDir, 'auth.json'), originalAuth)
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), originalClaude)
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(codexDir, 'config.toml'), 0o640)
      fs.chmodSync(path.join(codexDir, 'auth.json'), 0o600)
      fs.chmodSync(path.join(claudeDir, 'settings.json'), 0o644)
    }

    const firstUpstream = makeUpstream()
    const firstUpstreamPort = await listen(firstUpstream.server)
    const secondUpstream = makeUpstream()
    const secondUpstreamPort = await listen(secondUpstream.server)
    const proxy = makeHttpProxy()
    const proxyPort = await listen(proxy.server)
    const routerPort = await getFreePort()

    let enabled = false
    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          proxyUrl: `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`,
          provider: {
            id: 'first', name: 'First', baseUrl: `http://127.0.0.1:${firstUpstreamPort}/v1`,
            apiKey: 'upstream-first-key', model: 'model-first', format: 'openai', formatConversionEnabled: true,
          },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const auth = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'))
      const localToken = auth.OPENAI_API_KEY as string
      expect(localToken).toMatch(/^[a-f\d]{64}$/)
      expect(localToken).not.toBe('original-key')
      const routedConfig = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')
      expect(routedConfig).toContain('model_provider = "OpenAI"')
      expect(routedConfig).toContain('model = "router"')
      expect(routedConfig).toContain('[model_providers.router]\nname = "Previous Router"')
      const routerSection = routedConfig.match(/\[model_providers\.OpenAI\]([\s\S]*?)(?=\n\[|$)/)?.[1] || ''
      expect(routerSection).toContain('name = "router"')
      expect(routerSection).toContain(`base_url = "http://127.0.0.1:${routerPort}/openai/v1"`)
      expect(routerSection).toContain('wire_api = "responses"')
      expect(routerSection).toContain('requires_openai_auth = true')
      expect(routerSection).not.toContain('env_key')
      expect(routerSection).not.toContain('experimental_bearer_token')
      expect(routedConfig).not.toContain(localToken)
      expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'))).toEqual({
        model: 'router',
        theme: 'dark',
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${routerPort}/anthropic`, ANTHROPIC_MODEL: 'router',
          ANTHROPIC_AUTH_TOKEN: localToken,
        },
      })

      const firstResponse = await callRouter(routerPort, localToken, { model: 'client-model', stream: true })
      expect(firstResponse.status).toBe(200)
      expect(firstResponse.body).toContain('data: first')
      expect(proxy.requests[0]).toContain('POST http://127.0.0.1:')
      expect(proxy.requests[0]).toContain('Basic cHJveHktdXNlcjpwcm94eS1wYXNz')
      expect(firstUpstream.requests).toEqual([{
        url: '/v1/chat/completions',
        authorization: 'Bearer upstream-first-key',
        body: { model: 'model-first', stream: true },
      }])

      const configDuringRouting = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')
      const authDuringRouting = fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')
      const claudeDuringRouting = fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')
      const switchProvider = runHost(home, {
        action: 'setRouterProvider',
        config: {
          provider: {
            id: 'second', name: 'Second', baseUrl: `http://127.0.0.1:${secondUpstreamPort}/v1`,
            apiKey: 'upstream-second-key', model: 'model-second', format: 'openai', formatConversionEnabled: true,
          },
        },
      })
      expect(switchProvider.success, switchProvider.error).toBe(true)
      expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toBe(configDuringRouting)
      expect(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).toBe(authDuringRouting)
      expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(claudeDuringRouting)
      const secondResponse = await callRouter(routerPort, localToken, { model: 'client-model' })
      expect(secondResponse.status).toBe(200)
      expect(secondUpstream.requests[0]).toMatchObject({
        url: '/v1/chat/completions',
        authorization: 'Bearer upstream-second-key',
        body: { model: 'model-second' },
      })

      const updatedRouterPort = await getFreePort()
      const updateSettings = runHost(home, {
        action: 'updateRouterSettings',
        config: { port: updatedRouterPort, proxyUrl: '' },
      })
      expect(updateSettings.success, updateSettings.error).toBe(true)
      const directResponse = await callRouter(updatedRouterPort, localToken, { model: 'client-model' })
      expect(directResponse.status).toBe(200)
      expect(proxy.requests).toHaveLength(2)
      expect(secondUpstream.requests).toHaveLength(2)
      expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toContain(`http://127.0.0.1:${updatedRouterPort}/openai/v1`)
      expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'))).toEqual({
        model: 'router',
        theme: 'dark',
        env: {
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${updatedRouterPort}/anthropic`, ANTHROPIC_MODEL: 'router',
          ANTHROPIC_AUTH_TOKEN: localToken,
        },
      })

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
      expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toBe(originalConfig)
      expect(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).toBe(originalAuth)
      expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe(originalClaude)
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(codexDir, 'config.toml')).mode & 0o777).toBe(0o640)
        expect(fs.statSync(path.join(codexDir, 'auth.json')).mode & 0o777).toBe(0o600)
        expect(fs.statSync(path.join(claudeDir, 'settings.json')).mode & 0o777).toBe(0o644)
      }
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('keeps the local router token stable across disable and re-enable', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-token-'))
    temporaryHomes.push(home)
    const codexDir = path.join(home, '.codex')
    const claudeDir = path.join(home, '.claude')
    const codexSwitchDir = path.join(home, '.codexswitch')
    fs.mkdirSync(codexDir, { recursive: true })
    fs.mkdirSync(claudeDir, { recursive: true })
    const originalConfig = 'model_provider = "OpenAI"\nmodel = "gpt-original"\n'
    const originalAuth = '{"OPENAI_API_KEY":"original-key"}\n'
    fs.writeFileSync(path.join(codexDir, 'config.toml'), originalConfig)
    fs.writeFileSync(path.join(codexDir, 'auth.json'), originalAuth)
    const routerPort = await getFreePort()
    const config = {
      port: routerPort,
      provider: {
        id: 'stable-token', name: 'Stable token', baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'upstream-key', model: 'upstream-model', format: 'openai',
      },
    }
    const tokenFile = path.join(codexSwitchDir, 'router-token.json')
    let enabled = false

    try {
      const firstEnable = runHost(home, { action: 'enableRouterLegacy', config })
      expect(firstEnable.success, firstEnable.error).toBe(true)
      enabled = true
      const firstToken = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      expect(firstToken).toMatch(/^[a-f\d]{64}$/)
      expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).localToken).toBe(firstToken)
      if (process.platform !== 'win32') expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)

      // Simulate an installation upgraded while an older Router is already running.
      fs.rmSync(tokenFile)
      const firstDisable = runHost(home, { action: 'disableRouter' })
      expect(firstDisable.success, firstDisable.error).toBe(true)
      enabled = false
      expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).localToken).toBe(firstToken)
      expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toBe(originalConfig)
      expect(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).toBe(originalAuth)

      const secondEnable = runHost(home, { action: 'enableRouterLegacy', config })
      expect(secondEnable.success, secondEnable.error).toBe(true)
      enabled = true
      const secondToken = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).OPENAI_API_KEY
      expect(secondToken).toBe(firstToken)

      const secondDisable = runHost(home, { action: 'disableRouter' })
      expect(secondDisable.success, secondDisable.error).toBe(true)
      enabled = false
      expect(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')).toBe(originalConfig)
      expect(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8')).toBe(originalAuth)
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('refuses to rotate a malformed persisted router token', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-token-invalid-'))
    temporaryHomes.push(home)
    const codexSwitchDir = path.join(home, '.codexswitch')
    fs.mkdirSync(codexSwitchDir, { recursive: true })
    fs.writeFileSync(path.join(codexSwitchDir, 'router-token.json'), '{"version":1,"localToken":"broken"}')

    const result = runHost(home, {
      action: 'enableRouterLegacy',
      config: {
        port: await getFreePort(),
        provider: {
          id: 'invalid-token', name: 'Invalid token', baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'upstream-key', model: 'upstream-model', format: 'openai',
        },
      },
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid router token file')
    expect(fs.readFileSync(path.join(codexSwitchDir, 'router-token.json'), 'utf8')).toContain('broken')
  })

  it('forwards Anthropic Messages requests with Anthropic authentication and the selected model', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-anthropic-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('messages')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: {
            id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            apiKey: 'upstream-anthropic-key', model: 'claude-test', format: 'anthropic',
          },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'))
      const localToken = auth.OPENAI_API_KEY as string

      const response = await callRouter(routerPort, localToken, { model: 'client-model', max_tokens: 20 }, '/v1/messages')
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({ type: 'message', content: [{ type: 'text', text: 'converted' }], stop_reason: 'end_turn' })
      expect(upstream.requests[0]).toMatchObject({
        url: '/v1/messages',
        apiKey: 'upstream-anthropic-key',
        anthropicVersion: '2023-06-01',
        body: { model: 'claude-test', max_tokens: 20 },
      })
      expect(upstream.requests[0].authorization).toBeUndefined()

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('converts all client protocols to an OpenAI Chat Completions upstream', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-openai-convert-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('chat')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'openai', name: 'OpenAI', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'openai-key', model: 'gpt-router', format: 'openai', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const messages = await callRouter(routerPort, token, { model: 'client', system: 'system prompt', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 8 }, '/v1/messages')
      expect(messages.status).toBe(200)
      expect(JSON.parse(messages.body)).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'converted' }] })
      expect(upstream.requests[0]).toMatchObject({
        url: '/v1/chat/completions',
        authorization: 'Bearer openai-key',
        body: { model: 'gpt-router', messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 8 },
      })

      const toolMessages = await callRouter(routerPort, token, {
        model: 'client',
        max_tokens: 20,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { city: 'Tokyo' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Found Tokyo' }] },
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      }, '/v1/messages')
      expect(JSON.parse(toolMessages.body)).toMatchObject({
        type: 'message',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'lookup', input: { city: 'Tokyo' } }],
      })
      expect(upstream.requests[upstream.requests.length - 1]?.body).toMatchObject({
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{"city":"Tokyo"}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: 'Found Tokyo' },
        ],
      })

      const responses = await callRouter(routerPort, token, { model: 'client', instructions: 'response instructions', input: 'response input', max_output_tokens: 8 }, '/v1/responses')
      expect(responses.status).toBe(200)
      expect(JSON.parse(responses.body)).toMatchObject({ object: 'response', output_text: 'converted', status: 'completed' })
      expect(upstream.requests[2].body).toMatchObject({ model: 'gpt-router', messages: [{ role: 'system', content: 'response instructions' }, { role: 'user', content: 'response input' }], max_tokens: 8 })

      const responseStream = await callRouter(routerPort, token, { model: 'client', instructions: 'stream instructions', input: 'stream input', stream: true }, '/v1/responses')
      expect(responseStream.status).toBe(200)
      const responseEvents = parseSseEvents(responseStream.body)
      expect(responseEvents.map(item => item.data.sequence_number)).toEqual(responseEvents.map((_item, index) => index))
      expect(responseEvents.map(item => item.data.type)).toContain('response.in_progress')
      expect(responseEvents.some(item => item.data.type === 'response.output_text.delta' && item.data.delta === 'streamed')).toBe(true)
      expect(responseEvents[responseEvents.length - 1]?.data).toMatchObject({
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'streamed' }] }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      })

      const streamed = await callRouter(routerPort, token, { model: 'client', messages: [{ role: 'user', content: 'stream' }], stream: true }, '/v1/messages')
      expect(streamed.status).toBe(200)
      expect(streamed.body).toContain('event: content_block_delta')
      expect(streamed.body).toContain('"text":"streamed"')
      expect(streamed.body).toContain('event: message_stop')

      const chatToolStream = await callRouter(routerPort, token, {
        model: 'client',
        messages: [{ role: 'user', content: 'use lookup' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        stream: true,
      })
      const chatToolEvents = parseSseEvents(chatToolStream.body)
      expect(chatToolEvents.filter(item => item.data.choices?.length).every(item => item.data.choices[0].index === 0)).toBe(true)
      expect(chatToolEvents.some(item => item.data.choices?.[0]?.delta?.tool_calls?.[0]?.index === 1)).toBe(true)
      expect(chatToolEvents.find(item => item.data.choices?.[0]?.finish_reason)?.data.choices[0].finish_reason).toBe('tool_calls')
      expect(chatToolEvents.find(item => item.data.usage?.total_tokens)?.data.usage.total_tokens).toBe(7)

      const responseToolStream = await callRouter(routerPort, token, {
        model: 'client',
        input: 'use lookup',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        stream: true,
      }, '/v1/responses')
      const responseToolEvents = parseSseEvents(responseToolStream.body)
      expect(responseToolEvents.some(item => item.data.type === 'response.function_call_arguments.delta')).toBe(true)
      expect(responseToolEvents.at(-1)?.data).toMatchObject({
        type: 'response.completed',
        response: { output: [{ type: 'function_call', name: 'lookup', arguments: '{"city":"Tokyo"}' }] },
      })

      const messagesToolStream = await callRouter(routerPort, token, {
        model: 'client',
        messages: [{ role: 'user', content: 'use lookup' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        stream: true,
      }, '/v1/messages')
      const messagesToolEvents = parseSseEvents(messagesToolStream.body)
      expect(messagesToolEvents.some(item => item.data.type === 'content_block_start' && item.data.content_block?.type === 'tool_use')).toBe(true)
      expect(messagesToolEvents.some(item => item.data.type === 'content_block_delta' && item.data.delta?.type === 'input_json_delta')).toBe(true)
      expect(messagesToolEvents.at(-1)?.data.type).toBe('message_stop')

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('converts Codex Responses requests and Chat SSE tool calls for chat-only upstreams', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-codex-chat-upstream-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('chat')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'openai-chat-only', name: 'Chat only', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'openai-key', model: 'gpt-router', format: 'openai', apiType: 'chat', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const response = await callRouter(routerPort, token, {
        model: 'client-model',
        instructions: 'Use the available tool when needed.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Find Tokyo.' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'low' }] }],
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
        stream: true,
      }, '/v1/responses')

      expect(response.status).toBe(200)
      expect(upstream.requests[0]).toMatchObject({
        url: '/v1/chat/completions',
        body: {
          model: 'gpt-router',
          stream: true,
          messages: [
            { role: 'system', content: 'Use the available tool when needed.' },
            { role: 'user', content: [{ type: 'text', text: 'Find Tokyo.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'low' } }] },
          ],
        },
      })
      const events = parseSseEvents(response.body)
      expect(events.map(event => event.data.sequence_number)).toEqual(events.map((_event, index) => index))
      expect(events.map(event => event.data.type)).toContain('response.created')
      expect(events.map(event => event.data.type)).toContain('response.in_progress')
      expect(events.some(event => event.data.type === 'response.function_call_arguments.delta' && event.data.delta === '{"city":"Tokyo"}')).toBe(true)
      expect(events.some(event => event.data.type === 'response.function_call_arguments.done' && event.data.arguments === '{"city":"Tokyo"}')).toBe(true)
      expect(events.find(event => event.data.type === 'response.output_item.added')?.data).toMatchObject({
        output_index: 0,
        item: { type: 'function_call', id: 'fc_call-stream', call_id: 'call-stream', name: 'lookup' },
      })
      expect(events.at(-1)?.data).toMatchObject({
        type: 'response.completed',
        response: {
          output: [{ type: 'function_call', id: 'fc_call-stream', call_id: 'call-stream', name: 'lookup', arguments: '{"city":"Tokyo"}' }],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      })
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it.each(['/v1/responses', '/v1/chat/completions', '/v1/messages'])('preserves a chat-only upstream 502 for %s without probing Responses', async endpoint => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-codex-chat-error-'))
    temporaryHomes.push(home)
    const requests: Array<{ url: string; body: any }> = []
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        requests.push({ url: req.url || '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'openai_error', message: 'upstream chat failure' } }))
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'openai-chat-only-error', name: 'Chat only', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'openai-key', model: 'gpt-router', format: 'openai', apiType: 'chat', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const instructions = 'Use the available tool when needed.'
      const parameters = { type: 'object', properties: {} }
      const requestBody = endpoint === '/v1/responses'
        ? { instructions, input: 'Look up Tokyo.', tools: [{ type: 'function', name: 'lookup', parameters }] }
        : endpoint === '/v1/messages'
          ? { system: instructions, messages: [{ role: 'user', content: 'Look up Tokyo.' }], tools: [{ name: 'lookup', input_schema: parameters }] }
          : { messages: [{ role: 'system', content: instructions }, { role: 'user', content: 'Look up Tokyo.' }], tools: [{ type: 'function', function: { name: 'lookup', parameters } }] }
      const response = await callRouter(routerPort, token, { ...requestBody, model: 'client-model' }, endpoint)

      expect(response.status).toBe(502)
      expect(response.headers['x-codexswitch-error-source']).toBe('upstream-http')
      expect(JSON.parse(response.body)).toEqual({ error: { type: 'openai_error', message: 'upstream chat failure' } })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: '/v1/chat/completions',
        body: {
          model: 'gpt-router',
          messages: [
            { role: 'system', content: 'Use the available tool when needed.' },
            { role: 'user', content: 'Look up Tokyo.' },
          ],
          tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
        },
      })
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('keeps parallel Chat tool calls separate in the Responses SSE stream', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-codex-parallel-tools-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('chat')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'openai-chat-only', name: 'Chat only', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'openai-key', model: 'gpt-router', format: 'openai', apiType: 'chat', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const response = await callRouter(routerPort, token, {
        model: 'client-model',
        input: 'Use both tools.',
        tools: [
          { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
          { type: 'function', name: 'get_time', parameters: { type: 'object' } },
        ],
        stream: true,
      }, '/v1/responses')

      const events = parseSseEvents(response.body)
      const items = events.filter(event => event.data.type === 'response.output_item.done').map(event => event.data)
      expect(items).toHaveLength(2)
      expect(items.map(event => event.output_index)).toEqual([0, 1])
      expect(items.map(event => event.item)).toEqual([
        { id: 'fc_call-weather', type: 'function_call', status: 'completed', call_id: 'call-weather', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
        { id: 'fc_call-time', type: 'function_call', status: 'completed', call_id: 'call-time', name: 'get_time', arguments: '{"timezone":"Asia/Tokyo"}' },
      ])
      expect(events.at(-1)?.data.response.output).toHaveLength(2)
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('converts all client protocols to an Anthropic Messages upstream', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-anthropic-convert-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('messages')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'anthropic-key', model: 'claude-router', format: 'anthropic', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const chat = await callRouter(routerPort, token, { model: 'client', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }, '/v1/chat/completions')
      expect(chat.status).toBe(200)
      expect(JSON.parse(chat.body)).toMatchObject({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'converted' }, finish_reason: 'stop' }] })
      expect(upstream.requests[0]).toMatchObject({
        url: '/v1/messages',
        apiKey: 'anthropic-key',
        body: { model: 'claude-router', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 8 },
      })

      const responses = await callRouter(routerPort, token, { model: 'client', instructions: 'response instructions', input: 'response input', max_output_tokens: 8 }, '/v1/responses')
      expect(responses.status).toBe(200)
      expect(JSON.parse(responses.body)).toMatchObject({ object: 'response', output_text: 'converted', status: 'completed' })
      expect(upstream.requests[1].body).toMatchObject({ model: 'claude-router', system: 'response instructions', messages: [{ role: 'user', content: [{ type: 'text', text: 'response input' }] }], max_tokens: 8 })

      const toolResponse = await callRouter(routerPort, token, {
        model: 'client',
        input: [
          { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"city":"Tokyo"}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'Found Tokyo' },
        ],
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
        max_output_tokens: 20,
      }, '/v1/responses')
      expect(JSON.parse(toolResponse.body)).toMatchObject({
        object: 'response',
        output: [{ type: 'function_call', name: 'lookup', arguments: '{"city":"Tokyo"}' }],
      })
      expect(upstream.requests[upstream.requests.length - 1]?.body).toMatchObject({
        tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { city: 'Tokyo' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Found Tokyo' }] },
        ],
      })

      const streamed = await callRouter(routerPort, token, { model: 'client', messages: [{ role: 'user', content: 'stream' }], stream: true }, '/v1/chat/completions')
      expect(streamed.status).toBe(200)
      expect(streamed.body).toContain('data: {"id"')
      expect(streamed.body).toContain('"content":"streamed"')
      expect(streamed.body).toContain('data: [DONE]')

      const responseStream = await callRouter(routerPort, token, { model: 'client', input: 'stream', stream: true }, '/v1/responses')
      const responseEvents = parseSseEvents(responseStream.body)
      expect(responseEvents.some(item => item.data.type === 'response.output_text.delta' && item.data.delta === 'streamed')).toBe(true)
      expect(responseEvents.at(-1)?.data.type).toBe('response.completed')

      const messagesStream = await callRouter(routerPort, token, {
        model: 'client',
        messages: [{ role: 'user', content: 'stream' }],
        stream: true,
      }, '/v1/messages')
      const messagesEvents = parseSseEvents(messagesStream.body)
      expect(messagesEvents.some(item => item.data.type === 'content_block_delta' && item.data.delta?.text === 'streamed')).toBe(true)
      expect(messagesEvents.at(-1)?.data.type).toBe('message_stop')

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('maps Codex built-in tools per upstream protocol instead of leaking them verbatim', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-builtin-tools-'))
    temporaryHomes.push(home)
    const anthropicUpstream = makeProtocolUpstream('messages')
    const anthropicPort = await listen(anthropicUpstream.server)
    const chatUpstream = makeProtocolUpstream('chat')
    const chatPort = await listen(chatUpstream.server)
    const tools = [
      { type: 'web_search' },
      { type: 'file_search', name: 'files' },
      { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
    ]

    const anthropicRouterPort = await getFreePort()
    const enableAnthropic = runHost(home, {
      action: 'enableRouterLegacy',
      config: {
        port: anthropicRouterPort,
        provider: { id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${anthropicPort}/v1`, apiKey: 'anthropic-key', model: 'claude-router', format: 'anthropic', formatConversionEnabled: true },
      },
    })
    expect(enableAnthropic.success, enableAnthropic.error).toBe(true)
    let enabled = true
    try {
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const messages = await callRouter(anthropicRouterPort, token, {
        model: 'client',
        input: 'search the web',
        tools,
        max_output_tokens: 16,
      }, '/v1/responses')
      expect(messages.status).toBe(200)
      expect(anthropicUpstream.requests[0].body.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'files', input_schema: { type: 'object', properties: {} } },
        { name: 'lookup', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      ])
      expect(JSON.stringify(anthropicUpstream.requests[0].body.tools)).not.toContain('"type":"web_search"')
    } finally {
      if (enabled) {
        const disable = runHost(home, { action: 'disableRouter' })
        expect(disable.success, disable.error).toBe(true)
        enabled = false
      }
    }

    const chatRouterPort = await getFreePort()
    const enableChat = runHost(home, {
      action: 'enableRouterLegacy',
      config: {
        port: chatRouterPort,
        provider: { id: 'chat', name: 'Chat', baseUrl: `http://127.0.0.1:${chatPort}/v1`, apiKey: 'chat-key', model: 'chat-model', format: 'openai', apiType: 'chat', formatConversionEnabled: true },
      },
    })
    expect(enableChat.success, enableChat.error).toBe(true)
    enabled = true
    try {
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const responses = await callRouter(chatRouterPort, token, {
        model: 'client',
        input: 'search the web',
        tools,
        max_output_tokens: 16,
      }, '/v1/responses')
      expect(responses.status).toBe(200)
      expect(chatUpstream.requests[0].body.tools).toEqual([
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
      ])
    } finally {
      if (enabled) {
        const disable = runHost(home, { action: 'disableRouter' })
        expect(disable.success, disable.error).toBe(true)
        enabled = false
      }
    }
  })

  it('converts tool-only Anthropic streams to Responses without empty output blocks', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-anthropic-tool-stream-'))
    temporaryHomes.push(home)
    const upstream = makeProtocolUpstream('messages', 'tool')
    const upstreamPort = await listen(upstream.server)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: { id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'anthropic-key', model: 'claude-router', format: 'anthropic', formatConversionEnabled: true },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const response = await callRouter(routerPort, token, { model: 'client', input: 'look up Tokyo', stream: true }, '/v1/responses')
      expect(response.status).toBe(200)
      const events = parseSseEvents(response.body)
      expect(events.map(item => item.data.sequence_number)).toEqual(events.map((_item, index) => index))
      expect(events.some(item => item.data.type === 'response.content_part.added')).toBe(false)
      expect(events.some(item => item.data.type === 'response.output_text.delta')).toBe(false)
      expect(events[events.length - 1]?.data).toMatchObject({
        type: 'response.completed',
        response: {
          output: [{ type: 'function_call', call_id: 'toolu_stream', name: 'lookup', arguments: '{"city":"Tokyo"}' }],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        },
      })
      expect(events.filter(item => item.data.type === 'response.output_item.done')).toHaveLength(1)

      const chat = await callRouter(routerPort, token, {
        model: 'client',
        messages: [{ role: 'user', content: 'look up Tokyo' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
        stream: true,
      }, '/v1/chat/completions')
      const chatEvents = parseSseEvents(chat.body)
      expect(chatEvents.some(item => item.data.choices?.[0]?.delta?.tool_calls?.[0]?.id === 'toolu_stream')).toBe(true)
      expect(chatEvents.some(item => item.data.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true)

      const messages = await callRouter(routerPort, token, {
        model: 'client',
        messages: [{ role: 'user', content: 'look up Tokyo' }],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        stream: true,
      }, '/v1/messages')
      const messagesEvents = parseSseEvents(messages.body)
      expect(messagesEvents.some(item => item.data.type === 'content_block_start' && item.data.content_block?.type === 'tool_use')).toBe(true)
      expect(messagesEvents.some(item => item.data.type === 'content_block_delta' && item.data.delta?.type === 'input_json_delta')).toBe(true)
      expect(messagesEvents.at(-1)?.data.type).toBe('message_stop')

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('flushes split UTF-8 SSE tails and preserves upstream errors across protocols', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-sse-edge-'))
    temporaryHomes.push(home)
    const upstreamRequests: Array<{ url: string; body: any }> = []
    const tailEvent = Buffer.from(`data: ${JSON.stringify({
      id: 'chatcmpl-tail',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'upstream-model',
      choices: [{ index: 0, delta: { content: '中' }, finish_reason: 'stop' }],
    })}`)
    const characterOffset = tailEvent.indexOf(Buffer.from('中'))
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const requestUrl = req.url || ''
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        upstreamRequests.push({ url: requestUrl, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })

        if (new URL(requestUrl, 'http://upstream').searchParams.get('case') === 'tail') {
          res.write(tailEvent.subarray(0, characterOffset + 1))
          setTimeout(() => res.end(tailEvent.subarray(characterOffset + 1)), 5)
          return
        }

        if (new URL(requestUrl, 'http://upstream').pathname.endsWith('/messages')) {
          res.end('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"messages upstream failed"}}\n\n')
          return
        }

        res.end('data: {"error":{"type":"server_error","message":"chat upstream failed"}}\n\n')
      })
    })
    const upstreamPort = await listen(upstream)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          provider: {
            id: 'openai', name: 'OpenAI', baseUrl: `http://127.0.0.1:${upstreamPort}/v1?region=us`,
            apiKey: 'openai-key', model: 'gpt-router', format: 'openai', formatConversionEnabled: true,
          },
        },
      })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const token = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string

      const tail = await callRouter(routerPort, token, { model: 'client', input: 'hello', stream: true }, '/v1/responses?case=tail&region=client')
      expect(tail.status).toBe(200)
      const tailEvents = parseSseEvents(tail.body)
      expect(tailEvents.some(item => item.data.type === 'response.output_text.delta' && item.data.delta === '中')).toBe(true)
      expect(tailEvents[tailEvents.length - 1]?.data.type).toBe('response.completed')
      expect(upstreamRequests[0]?.url).toBe('/v1/chat/completions?region=client&case=tail')

      const chatErrorAsResponses = await callRouter(routerPort, token, { model: 'client', input: 'hello', stream: true }, '/v1/responses?case=chat-error')
      const chatErrorEvents = parseSseEvents(chatErrorAsResponses.body)
      expect(chatErrorEvents.some(item => item.data.type === 'response.failed' && item.data.response.error.message === 'chat upstream failed')).toBe(true)
      expect(chatErrorEvents.some(item => item.data.type === 'response.completed')).toBe(false)

      const chatErrorAsMessages = await callRouter(routerPort, token, { model: 'client', messages: [{ role: 'user', content: 'hello' }], stream: true }, '/v1/messages?case=chat-error')
      const messageErrorEvents = parseSseEvents(chatErrorAsMessages.body)
      expect(messageErrorEvents.some(item => item.event === 'error' && item.data.error.message === 'chat upstream failed')).toBe(true)
      expect(messageErrorEvents.some(item => item.event === 'message_stop')).toBe(false)

      const switchProvider = runHost(home, {
        action: 'setRouterProvider',
        config: {
          provider: {
            id: 'anthropic', name: 'Anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            apiKey: 'anthropic-key', model: 'claude-router', format: 'anthropic', formatConversionEnabled: true,
          },
        },
      })
      expect(switchProvider.success, switchProvider.error).toBe(true)

      const messagesErrorAsResponses = await callRouter(routerPort, token, { model: 'client', input: 'hello', stream: true }, '/v1/responses?case=messages-error')
      const messagesErrorEvents = parseSseEvents(messagesErrorAsResponses.body)
      expect(messagesErrorEvents.some(item => item.data.type === 'response.failed' && item.data.response.error.message === 'messages upstream failed')).toBe(true)
      expect(messagesErrorEvents.some(item => item.data.type === 'response.completed')).toBe(false)

      const messagesErrorAsChat = await callRouter(routerPort, token, {
        model: 'client',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'system prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
      }, '/v1/chat/completions?case=messages-error')
      expect(messagesErrorAsChat.body).toContain('messages upstream failed')
      expect(messagesErrorAsChat.body).not.toContain('"finish_reason":"stop"')
      expect(upstreamRequests.at(-1)?.body.system).toEqual([
        { type: 'text', text: 'system prompt' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      ])

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })

  it('connects to HTTPS providers through an HTTP proxy tunnel', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-router-tunnel-'))
    temporaryHomes.push(home)
    const secureRequests: string[] = []
    const upstream = https.createServer({
      key: fs.readFileSync(testKeyPath),
      cert: fs.readFileSync(testCertPath),
    }, (req, res) => {
      secureRequests.push(`${req.url} ${req.headers.authorization || ''}`)
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('secure upstream response')
      })
    })
    const upstreamPort = await listenSecure(upstream)
    const tunnelTargets: string[] = []
    const proxy = http.createServer()
    proxy.on('connect', (req, clientSocket, head) => {
      tunnelSockets.add(clientSocket)
      clientSocket.on('close', () => tunnelSockets.delete(clientSocket))
      tunnelTargets.push(`${req.url} ${req.headers['proxy-authorization'] || ''}`)
      const targetPort = Number((req.url || '').split(':').at(-1))
      const upstreamSocket = net.connect(targetPort, '127.0.0.1', () => {
        tunnelSockets.add(upstreamSocket)
        upstreamSocket.on('close', () => tunnelSockets.delete(upstreamSocket))
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstreamSocket.write(head)
        clientSocket.pipe(upstreamSocket)
        upstreamSocket.pipe(clientSocket)
      })
      upstreamSocket.on('error', () => clientSocket.destroy())
    })
    const proxyPort = await listen(proxy)
    const routerPort = await getFreePort()
    let enabled = false

    try {
      const enable = runHost(home, {
        action: 'enableRouterLegacy',
        config: {
          port: routerPort,
          proxyUrl: `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`,
          provider: {
            id: 'https', name: 'HTTPS', baseUrl: `https://localhost:${upstreamPort}/v1`,
            apiKey: 'https-upstream-key', model: 'https-model', format: 'openai',
          },
        },
      }, { NODE_EXTRA_CA_CERTS: testCertPath })
      expect(enable.success, enable.error).toBe(true)
      enabled = true
      const localToken = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY as string
      const response = await callRouter(routerPort, localToken, { model: 'client-model' })
      expect(response.status).toBe(200)
      expect(response.body).toBe('secure upstream response')
      expect(tunnelTargets).toEqual([`localhost:${upstreamPort} Basic cHJveHktdXNlcjpwcm94eS1wYXNz`])
      expect(secureRequests).toEqual(['/v1/chat/completions Bearer https-upstream-key'])

      const disable = runHost(home, { action: 'disableRouter' })
      expect(disable.success, disable.error).toBe(true)
      enabled = false
    } finally {
      if (enabled) runHost(home, { action: 'disableRouter' })
    }
  })
})
