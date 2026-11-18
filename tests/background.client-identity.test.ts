import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as storage from '../src/utils/storage'
import * as system from '../src/utils/systemConfig'
import * as identityRules from '../src/utils/clientIdentityRules'

vi.mock('../src/utils/storage')
vi.mock('../src/utils/systemConfig')
vi.mock('../src/utils/clientIdentityRules')

let dispatch: (message: unknown, sender: unknown, response: (result: any) => void) => void
let store: Record<string, unknown>
let rules: chrome.declarativeNetRequest.Rule[]
const send = (type: string, payload?: unknown) => new Promise<any>(resolve => dispatch({ type, payload }, {}, resolve))

beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  store = { client_identity: { default: { preset: 'codex', version: '1' }, formatIdentities: {} } }
  rules = []
  vi.stubGlobal('chrome', {
    sidePanel: { setOptions: vi.fn() },
    action: { onClicked: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: {
      onMessage: { addListener: vi.fn(listener => { dispatch = listener }) },
      onConnect: { addListener: vi.fn() },
    },
    storage: {
      onChanged: { addListener: vi.fn() },
      local: { get: vi.fn(async () => ({ ...store })), set: vi.fn(async update => { Object.assign(store, update) }) },
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => [...rules]),
      updateDynamicRules: vi.fn(async ({ removeRuleIds, addRules }) => {
        rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...addRules]
      }),
    },
  })
  vi.mocked(identityRules.syncClientIdentityRules).mockResolvedValue({ ok: true, ruleCount: 0 })
  vi.mocked(storage.getProviders).mockResolvedValue([{ baseUrl: 'https://identity.example.test', format: 'openai' } as any])
  vi.mocked(system.updateRouterClientIdentity).mockResolvedValue({ success: true })
  await import('../src/background/index')
  await vi.waitFor(() => expect(identityRules.syncClientIdentityRules).toHaveBeenCalled())
})

afterEach(() => vi.unstubAllGlobals())

describe('background client identity application', () => {
  it('does not let a slow older refresh overwrite a newer save', async () => {
    let release!: (providers: any) => void
    vi.mocked(storage.getProviders).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = send('GET_CLIENT_IDENTITY')
    await vi.waitFor(() => expect(release).toBeDefined())
    const latest = { default: { preset: 'codex', version: '2' }, formatIdentities: {} }
    const saving = send('SET_CLIENT_IDENTITY', latest)
    await new Promise(resolve => setTimeout(resolve, 10))
    release([{ baseUrl: 'https://identity.example.test', format: 'openai' }])
    const [, result] = await Promise.all([older, saving])
    expect(result).toEqual({ success: true, data: latest })
    expect(identityRules.syncClientIdentityRules).toHaveBeenLastCalledWith(
      [{ baseUrl: 'https://identity.example.test', format: 'openai' }],
      latest,
    )
    expect(rules).toHaveLength(0)
    expect(system.updateRouterClientIdentity).toHaveBeenLastCalledWith(latest)
  })

  it('reports Router application failures and accepts a later retry', async () => {
    vi.mocked(system.updateRouterClientIdentity).mockResolvedValueOnce({ success: false, error: 'Native host unavailable' })
    const latest = { default: { preset: 'off' }, formatIdentities: {} }
    const result = await send('SET_CLIENT_IDENTITY', latest)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Native host unavailable')
    expect(store.client_identity).toEqual(latest)
    expect((await send('SET_CLIENT_IDENTITY', latest)).success).toBe(true)
  })

  it('reports browser rule application failures instead of claiming the identity was applied', async () => {
    vi.mocked(identityRules.syncClientIdentityRules).mockResolvedValueOnce({ ok: false, ruleCount: 0, error: 'Invalid header' })
    const result = await send('SET_CLIENT_IDENTITY', { default: { preset: 'custom', userAgent: 'custom/2' }, formatIdentities: {} })
    expect(result.success).toBe(false)
    expect((await send('SET_CLIENT_IDENTITY', { default: { preset: 'off' }, formatIdentities: {} })).success).toBe(true)
  })
})
