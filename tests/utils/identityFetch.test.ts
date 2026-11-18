import { afterEach, expect, it, vi } from 'vitest'
import { identityFetch } from '../../src/utils/identityFetch'

afterEach(() => vi.unstubAllGlobals())

it('isolates simultaneous Messages requests by provider type even at the exact same URL', async () => {
  const settings = { default: { preset: 'off' }, formatIdentities: {
    anthropic: { preset: 'custom', userAgent: 'Anthropic-test/1', extraHeaders: { 'x-client-name': 'anthropic-test' } },
    deepseek: { preset: 'custom', userAgent: 'Harness-test/2', extraHeaders: { 'x-client-name': 'harness-test' } },
  } }
  let activeUA: string | undefined
  const updateSessionRules = vi.fn(async (change: any) => {
    activeUA = change.addRules?.[0]?.action.requestHeaders[0].value
  })
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-test-id' },
    storage: { local: { get: vi.fn(async () => ({ client_identity: settings })) } },
    declarativeNetRequest: { updateSessionRules },
  })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sent: Array<{ ua?: string; client: string | null; key: string | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const headers = new Headers(init.headers)
    sent.push({ ua: activeUA, client: headers.get('x-client-name'), key: headers.get('x-api-key') })
    if (sent.length === 1) await gate
    return new Response('{}')
  }))
  const url = 'https://relay.example/v1/messages'
  const init = { method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' }, body: '{}' }
  const first = identityFetch(url, init, 'anthropic', 'messages')
  const second = identityFetch(url, init, 'deepseek', 'messages')
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(activeUA).toBe('Anthropic-test/1')
  release()
  await Promise.all([first, second])
  expect(sent).toEqual([
    { ua: 'Anthropic-test/1', client: 'anthropic-test', key: 'test-key' },
    { ua: 'Harness-test/2', client: 'harness-test', key: 'test-key' },
  ])
  expect(activeUA).toBeUndefined()
  for (const [change] of updateSessionRules.mock.calls) {
    if (!change.addRules?.length) continue
    const condition = change.addRules[0].condition
    expect(condition.initiatorDomains).toEqual(['extension-test-id'])
    expect(condition.resourceTypes).toEqual(['xmlhttprequest'])
    expect(new RegExp(condition.regexFilter).test(url)).toBe(true)
    expect(new RegExp(condition.regexFilter).test(url + '/other')).toBe(false)
  }
  await identityFetch(url, init, 'openai', 'messages')
  expect(sent[2]).toEqual({ ua: undefined, client: null, key: 'test-key' })
})

it('removes the session rule after transport failure and allows the next request', async () => {
  const updateSessionRules = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('chrome', { runtime: { id: 'extension-test-id' },
    storage: { local: { get: vi.fn().mockResolvedValue({ client_identity: { default: { preset: 'codex' }, formatIdentities: {} } }) } },
    declarativeNetRequest: { updateSessionRules },
  })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('{}')))
  await expect(identityFetch('https://relay.example/v1/responses', {}, 'openai', 'responses')).rejects.toThrow('offline')
  expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [7400] })
  await expect(identityFetch('https://relay.example/v1/responses', {}, 'openai', 'responses')).resolves.toBeInstanceOf(Response)
})
