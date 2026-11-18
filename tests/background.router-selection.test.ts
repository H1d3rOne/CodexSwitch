import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../src/types'
import * as storage from '../src/utils/storage'
import * as system from '../src/utils/systemConfig'

vi.mock('../src/utils/storage')
vi.mock('../src/utils/systemConfig')

let dispatch: (message: unknown, sender: unknown, response: (result: any) => void) => void
const providers = [
  { id: 'o', name: 'OpenAI', format: 'openai', isActive: true, formatConversionEnabled: true, routerActiveFormats: ['openai'] },
  { id: 'a', name: 'Anthropic', format: 'anthropic', isActive: true, formatConversionEnabled: true, routerActiveFormats: ['anthropic'] },
] as Provider[]
const send = (type: string, payload?: unknown) => new Promise<any>(resolve => dispatch({ type, payload }, {}, resolve))

beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  vi.stubGlobal('chrome', {
    sidePanel: { setOptions: vi.fn() },
    action: { onClicked: { addListener: vi.fn() } },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: {
      onMessage: { addListener: vi.fn(listener => { dispatch = listener }) },
      onConnect: { addListener: vi.fn() },
    },
    storage: { local: { get: vi.fn().mockResolvedValue({ router_enabled: true, router_clients: { openai: true, anthropic: true } }), set: vi.fn() } },
  })
  vi.mocked(storage.getProviders).mockResolvedValue(providers)
  vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: { openai: true, anthropic: true } } })
  vi.mocked(system.updateLocalRouterProvider).mockResolvedValue({ success: true })
  vi.mocked(system.setClientRouting).mockResolvedValue({ success: true })
  vi.mocked(system.updateCodexSystemForProvider).mockResolvedValue({ success: true })
  await import('../src/background/index')
})

describe('router provider activation', () => {
  it('continues queued client changes after an earlier operation rejects', async () => {
    vi.mocked(system.getRouterStatus).mockRejectedValueOnce(new Error('Native host unavailable'))
    const [failed, succeeded] = await Promise.all([
      send('SET_CLIENT_ROUTING', { format: 'openai', enabled: true }),
      send('SET_CLIENT_ROUTING', { format: 'anthropic', enabled: true }),
    ])
    expect(failed).toEqual({ success: false, error: 'Native host unavailable' })
    expect(succeeded.success).toBe(true)
    expect(system.setClientRouting).toHaveBeenCalledTimes(1)
    expect(system.setClientRouting).toHaveBeenCalledWith('anthropic', true, providers[1])
  })

  it('serializes simultaneous client changes without overwriting other switch states', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([...providers, { id: 'd', format: 'deepseek', isActive: true } as Provider])
    let clients: Record<string, boolean> = {}
    vi.mocked(system.getRouterStatus).mockImplementation(async () => ({ success: true, data: { enabled: true, running: true, clients: { ...clients } } }))
    vi.mocked(system.setClientRouting).mockImplementation(async (format, enabled) => {
      const updated = { ...clients, [format]: enabled }
      await new Promise(resolve => setTimeout(resolve, 10))
      clients = updated
      return { success: true, data: { enabled: true, running: true, clients: { ...updated } } }
    })
    const formats = ['openai', 'anthropic', 'deepseek'] as const
    const results = await Promise.all(formats.map(format => send('SET_CLIENT_ROUTING', { format, enabled: true })))
    expect(results.every(result => result.success)).toBe(true)
    expect(clients).toEqual({ openai: true, anthropic: true, deepseek: true })
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({ router_clients: clients })
  })

  it('isolates all client switches and restores native selections after converted routing', async () => {
    const actual = await vi.importActual<typeof storage>('../src/utils/storage')
    const persisted: Record<string, any> = {
      codex_switch_data: { providers: [
        { ...providers[0], routerActiveFormats: ['anthropic'], routerEffectiveFormats: ['anthropic'] },
        { ...providers[1], routerActiveFormats: ['openai'], routerEffectiveFormats: ['openai'] },
        { id: 'd', format: 'deepseek', isActive: true },
      ], activeProviderId: 'o' },
      router_clients: {},
    }
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key: any) => ({ [key]: persisted[key] }) as any)
    vi.mocked(chrome.storage.local.set).mockImplementation(async (values: any) => { Object.assign(persisted, values) })
    vi.mocked(storage.getProviders).mockImplementation(actual.getProviders)
    vi.mocked(storage.setRouterEffectiveProvider).mockImplementation(actual.setRouterEffectiveProvider)
    const clients: Record<string, boolean> = {}
    vi.mocked(system.getRouterStatus).mockImplementation(async () => ({ success: true, data: { enabled: true, running: true, clients: { ...clients } } }))
    vi.mocked(system.setClientRouting).mockImplementation(async (format, enabled) => {
      clients[format] = enabled
      return { success: true, data: { enabled: true, running: true, clients: { ...clients } } }
    })
    const before = await actual.getProviders()
    for (const format of ['openai', 'anthropic', 'deepseek'] as const) {
      for (const enabled of [true, false, true]) {
        const otherClients = Object.fromEntries(Object.entries(clients).filter(([key]) => key !== format))
        expect(await send('SET_CLIENT_ROUTING', { format, enabled })).toMatchObject({ success: true })
        expect(Object.fromEntries(Object.entries(persisted.router_clients).filter(([key]) => key !== format))).toEqual(otherClients)
        const selected = await actual.getProviders()
        expect(selected.map(provider => provider.isActive)).toEqual([true, true, true])
        expect(selected.map(provider => provider.routerActiveFormats)).toEqual(before.map(provider => provider.routerActiveFormats))
      }
    }
    expect(vi.mocked(system.setClientRouting).mock.calls.map(([format, enabled, provider]) => [format, enabled, provider?.id])).toEqual([
      ['openai', true, 'a'], ['openai', false, 'o'], ['openai', true, 'a'],
      ['anthropic', true, 'o'], ['anthropic', false, 'a'], ['anthropic', true, 'o'],
      ['deepseek', true, 'd'], ['deepseek', false, 'd'], ['deepseek', true, 'd'],
    ])
  })

  it('starts an empty service without touching client configurations', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([])
    vi.mocked(system.enableLocalRouter).mockResolvedValue({ success: true })
    expect((await send('ENABLE_ROUTER', { port: 15721 })).success).toBe(true)
    expect(system.enableLocalRouter).toHaveBeenCalledWith(undefined, 15721, '', {})
    expect(system.setClientRouting).not.toHaveBeenCalled()
    expect(system.updateCodexSystemForProvider).not.toHaveBeenCalled()
  })

  it('leaves service running after partial direct restoration failure', async () => {
    vi.mocked(system.setClientRouting).mockResolvedValueOnce({ success: true, data: { enabled: true, running: true, clients: { openai: false, anthropic: true } } }).mockResolvedValueOnce({ success: false, error: 'invalid settings' })
    expect(await send('DISABLE_ROUTER')).toEqual({ success: false, error: 'invalid settings' })
    expect(system.disableLocalRouter).not.toHaveBeenCalled()
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ router_clients: { openai: false, anthropic: true } })
  })

  it('requires a running service and a selected provider for client enable', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: false, running: false } })
    expect((await send('SET_CLIENT_ROUTING', { format: 'openai', enabled: true })).success).toBe(false)
    expect(system.setClientRouting).not.toHaveBeenCalled()
  })
  it.each(['openai', 'anthropic'] as const)('switches only the selected %s entry without rewriting client configuration', async targetFormat => {
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'o', sync: true, targetFormat })).toEqual({ success: true })
    expect(system.updateLocalRouterProvider).toHaveBeenCalledWith(providers[0], targetFormat)
    if (targetFormat === 'openai') {
      expect(storage.setActiveProvider).toHaveBeenCalledWith('o', true)
      expect(storage.setRouterActiveProvider).toHaveBeenCalledWith('o', 'openai')
    } else {
      expect(storage.setActiveProvider).not.toHaveBeenCalled()
      expect(storage.setRouterActiveProvider).toHaveBeenCalledWith('o', targetFormat)
    }
    expect(system.updateCodexSystemForProvider).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
  })

  it.each(['anthropic', 'openai'] as const)('rejects a converted %s selection while that client is not routed', async targetFormat => {
    const status = { success: true, data: { enabled: true, running: true, clients: {} } }
    vi.mocked(system.getRouterStatus).mockResolvedValue(status)
    const source = providers.find(provider => provider.format !== targetFormat)!
    vi.mocked(storage.getProviders).mockResolvedValue(providers)
    expect(await send('SET_ACTIVE_PROVIDER', { id: source.id, sync: true, targetFormat })).toEqual({ success: false, error: 'Enable client routing for this format before selecting a converted provider' })
    expect(system.setClientRouting).not.toHaveBeenCalled()
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
    expect(storage.setRouterActiveProvider).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
    expect(system.updateCodexSystemForProvider).not.toHaveBeenCalled()
  })

  it('requires the routing service for a converted entry even when client routing is stale-on', async targetFormat => {
    const status = { success: true, data: { enabled: true, running: false, clients: { anthropic: true } } }
    vi.mocked(system.getRouterStatus).mockResolvedValue(status)
    vi.mocked(storage.getProviders).mockResolvedValue(providers)
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'o', targetFormat: 'anthropic' })).toEqual({ success: false, error: 'Router service is unavailable; client remains routed' })
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
    expect(storage.setRouterActiveProvider).not.toHaveBeenCalled()
  })

  it('reports the promotion failure instead of activating a converted entry', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: { anthropic: true } } })
    vi.mocked(system.updateLocalRouterProvider).mockResolvedValue({ success: false, error: 'claude settings locked' })
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'o', targetFormat: 'anthropic' })).toEqual({ success: false, error: 'claude settings locked' })
    expect(storage.setRouterActiveProvider).not.toHaveBeenCalled()
  })

  it('still requires an enabled router for a converted entry when the service is stopped', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: false, running: false } })
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ router_clients: {} })
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'o', targetFormat: 'anthropic' })).toEqual({ success: false, error: 'Enable the router before selecting a converted provider' })
    expect(system.setClientRouting).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
  })

  it('syncs direct selections into the local client config even when the service runs', async () => {
    const status = { success: true, data: { enabled: true, running: true, clients: { anthropic: false } } }
    vi.mocked(system.getRouterStatus).mockResolvedValue(status)
    vi.mocked(system.updateClaudeSettingsForProvider).mockResolvedValue({ success: true })
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'a', sync: true, targetFormat: 'anthropic' })).toEqual({ success: true })
    expect(system.updateClaudeSettingsForProvider).toHaveBeenCalledWith(providers[1])
    expect(storage.setActiveProvider).toHaveBeenCalledWith('a')
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
  })

  it('keeps both active selections and local client configuration unchanged on native failure', async () => {
    vi.mocked(system.updateLocalRouterProvider).mockResolvedValue({ success: false, error: 'offline' })
    expect(await send('SET_ACTIVE_PROVIDER', { id: 'a', targetFormat: 'openai' })).toEqual({ success: false, error: 'offline' })
    expect(storage.setRouterActiveProvider).not.toHaveBeenCalled()
    expect(storage.setActiveProvider).not.toHaveBeenCalled()
    expect(system.updateCodexSystemForProvider).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
  })

  it('does not fall back to direct sync when the status query fails but router is enabled', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: false })
    await send('SET_ACTIVE_PROVIDER', { id: 'a', sync: true, targetFormat: 'anthropic' })
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
  })

  it('enables independent OpenAI and Anthropic upstreams', async () => {
    vi.mocked(system.enableLocalRouter).mockResolvedValue({ success: true })
    await send('ENABLE_ROUTER', { port: 15721 })
    expect(system.enableLocalRouter).toHaveBeenCalledWith(providers[0], 15721, '', { openai: providers[0], anthropic: providers[1] })
  })

  it('preserves a converted route when editing its native alternative', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([providers[0], { ...providers[1], routerActiveFormats: ['openai'] }])
    await send('UPDATE_PROVIDER', { id: 'o', updates: { apiKey: 'changed' } })
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
  })

  it('restores the last native route after conversion selection and router restart', async () => {
    // Use real storage so this exercises persisted selection, not a mirrored mock.
    const actual = await vi.importActual<typeof storage>('../src/utils/storage')
    const persisted: Record<string, any> = {
      codex_switch_data: { providers: providers.map(provider => ({ ...provider, routerActiveFormats: [] })), activeProviderId: 'o' },
    }
    vi.mocked(chrome.storage.local.get).mockImplementation(async (key: any) => ({ [key]: persisted[key] }) as any)
    vi.mocked(chrome.storage.local.set).mockImplementation(async (values: any) => { Object.assign(persisted, values) })
    vi.mocked(storage.getProviders).mockImplementation(actual.getProviders)
    vi.mocked(storage.setActiveProvider).mockImplementation(actual.setActiveProvider)
    vi.mocked(storage.setRouterActiveProvider).mockImplementation(actual.setRouterActiveProvider)
    await send('SET_ACTIVE_PROVIDER', { id: 'o', targetFormat: 'anthropic' })
    await send('SET_ACTIVE_PROVIDER', { id: 'a', targetFormat: 'anthropic' })
    expect(vi.mocked(system.updateLocalRouterProvider).mock.calls.map(([provider, target]) => [provider.id, target])).toEqual([['o', 'anthropic'], ['a', 'anthropic']])
    vi.mocked(system.disableLocalRouter).mockResolvedValue({ success: true })
    vi.mocked(system.updateCodexSystemForProvider).mockResolvedValue({ success: true })
    vi.mocked(system.updateClaudeSettingsForProvider).mockResolvedValue({ success: true })
    await send('DISABLE_ROUTER')
    vi.mocked(system.enableLocalRouter).mockResolvedValue({ success: true })
    await send('ENABLE_ROUTER', { port: 15721 })
    const routes = vi.mocked(system.enableLocalRouter).mock.calls[0][3]!
    expect(routes.openai?.id).toBe('o')
    expect(routes.anthropic?.id).toBe('a')
    const saved = await actual.getProviders()
    expect(saved.find(provider => provider.id === 'o')).toMatchObject({ isActive: true, routerActiveFormats: ['anthropic'] })
    expect(saved.find(provider => provider.id === 'a')).toMatchObject({ isActive: true, routerEffectiveFormats: ['anthropic'] })
  })

  it('updates native and converted routes sharing the edited provider', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([{ ...providers[0], routerActiveFormats: ['anthropic'] }])
    await send('UPDATE_PROVIDER', { id: 'o', updates: { apiKey: 'changed' } })
    expect(vi.mocked(system.updateLocalRouterProvider).mock.calls.map(call => call[1])).toEqual(['openai', 'anthropic'])
  })

  it('enables converted routes without replacing either selection', async () => {
    const converted = { ...providers[1], routerActiveFormats: ['openai'] } as Provider
    vi.mocked(storage.getProviders).mockResolvedValue([providers[0], converted])
    vi.mocked(system.enableLocalRouter).mockResolvedValue({ success: true })
    await send('ENABLE_ROUTER', { port: 15721 })
    expect(system.enableLocalRouter).toHaveBeenCalledWith(converted, 15721, '', { openai: converted, anthropic: converted })
    expect(storage.setRouterActiveProvider).not.toHaveBeenCalled()
    expect(storage.setActiveProvider).not.toHaveBeenCalled()
  })

  it('restores all native selections when disabling the router', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue(providers.map(provider => ({ ...provider, isActive: true })))
    vi.mocked(system.disableLocalRouter).mockResolvedValue({ success: true })
    vi.mocked(system.updateCodexSystemForProvider).mockResolvedValue({ success: true })
    vi.mocked(system.updateClaudeSettingsForProvider).mockResolvedValue({ success: true })
    expect((await send('DISABLE_ROUTER')).success).toBe(true)
    expect(system.setClientRouting).toHaveBeenCalledWith('openai', false, expect.objectContaining({ id: 'o' }))
    expect(system.setClientRouting).toHaveBeenCalledWith('anthropic', false, expect.objectContaining({ id: 'a' }))
    expect(vi.mocked(system.setClientRouting).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(system.disableLocalRouter).mock.invocationCallOrder[0])
  })

  it('prevents deleting an upstream still used by an entry', async () => {
    expect((await send('DELETE_PROVIDER', 'a')).success).toBe(false)
    expect(storage.deleteProvider).not.toHaveBeenCalled()
  })

  it('prevents disabling conversion while a converted entry uses the upstream', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([{ ...providers[0], routerActiveFormats: ['anthropic'] }])
    expect((await send('UPDATE_PROVIDER', { id: 'o', updates: { formatConversionEnabled: false } })).success).toBe(false)
    expect(storage.updateProvider).not.toHaveBeenCalled()
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
  })
})

describe('provider deletion routing guard', () => {
  it.each(['openai', 'anthropic', 'deepseek'] as const)('deletes an unused active %s provider without changing other routes', async format => {
    const actual = await vi.importActual<typeof storage>('../src/utils/storage')
    const unused = { ...providers[0], id: 'unused', format, routerActiveFormats: [format], routerEffectiveFormats: [format] }
    const otherFormat = format === 'openai' ? 'anthropic' : 'openai'
    const other = { ...providers[1], id: 'other', format: otherFormat, routerActiveFormats: [otherFormat], routerEffectiveFormats: [otherFormat] }
    const persisted: Record<string, any> = {
      codex_switch_data: { providers: [unused, other], activeProviderId: unused.id },
      router_enabled: true,
      router_clients: { [format]: false, [otherFormat]: true },
    }
    vi.mocked(chrome.storage.local.get).mockImplementation(async (keys: any) =>
      Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, persisted[key]])))
    vi.mocked(chrome.storage.local.set).mockImplementation(async (values: any) => { Object.assign(persisted, values) })
    vi.mocked(storage.getProviders).mockImplementation(actual.getProviders)
    vi.mocked(storage.deleteProvider).mockImplementation(actual.deleteProvider)
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: persisted.router_clients } })
    const otherBefore = (await actual.getProviders()).find(provider => provider.id === other.id)!

    expect(await send('DELETE_PROVIDER', unused.id)).toEqual({ success: true })
    expect(persisted.codex_switch_data.providers).toEqual([otherBefore])
    expect(persisted.codex_switch_data.activeProviderId).toBeNull()
    expect(persisted.router_clients).toEqual({ [format]: false, [otherFormat]: true })
    expect(persisted.router_enabled).toBe(true)
    expect(system.setClientRouting).not.toHaveBeenCalled()
    expect(system.disableLocalRouter).not.toHaveBeenCalled()
    expect(system.updateLocalRouterProvider).not.toHaveBeenCalled()
    expect(system.updateCodexSystemForProvider).not.toHaveBeenCalled()
    expect(system.updateClaudeSettingsForProvider).not.toHaveBeenCalled()
    expect(system.updateDeepSeekHarnessConfig).not.toHaveBeenCalled()
  })

  it('uses live empty client routes instead of stale cached enabled switches', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: {} } })
    expect(await send('DELETE_PROVIDER', 'o')).toEqual({ success: true })
    expect(storage.deleteProvider).toHaveBeenCalledWith('o')
  })

  it('deletes an unused converted selection when only an unrelated client is routed', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([
      { ...providers[0], routerActiveFormats: ['anthropic'], routerEffectiveFormats: ['anthropic'] },
      { ...providers[1], routerActiveFormats: ['openai'], routerEffectiveFormats: ['openai'] },
    ])
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: { openai: true, anthropic: false } } })
    expect(await send('DELETE_PROVIDER', 'o')).toEqual({ success: true })
    expect(storage.deleteProvider).toHaveBeenCalledWith('o')
  })

  it('still protects an upstream selected by an active converted client', async () => {
    vi.mocked(storage.getProviders).mockResolvedValue([
      { ...providers[0], routerActiveFormats: ['anthropic'], routerEffectiveFormats: ['anthropic'] },
      providers[1],
    ])
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: true, running: true, clients: { anthropic: true } } })
    const result = await send('DELETE_PROVIDER', 'o')
    expect(result.success).toBe(false)
    expect(result.error).toContain('anthropic')
    expect(storage.deleteProvider).not.toHaveBeenCalled()
    expect(system.setClientRouting).not.toHaveBeenCalled()
  })

  it('uses cached per-client switches when the Native Host is unavailable', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: false, error: 'Native Host unavailable' })
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ router_enabled: true, router_clients: { anthropic: true } })
    expect(await send('DELETE_PROVIDER', 'o')).toEqual({ success: true })
    expect((await send('DELETE_PROVIDER', 'a')).success).toBe(false)
    expect(storage.deleteProvider).toHaveBeenCalledTimes(1)
    expect(storage.deleteProvider).toHaveBeenCalledWith('o')
  })

  it('does not delete a selected upstream when enabled routing cannot be determined', async () => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: false, error: 'Native Host unavailable' })
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ router_enabled: true })
    const result = await send('DELETE_PROVIDER', 'o')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Router')
    expect(storage.deleteProvider).not.toHaveBeenCalled()
  })
})

describe('direct active provider edits', () => {
  const writers = {
    openai: system.updateCodexSystemForProvider,
    anthropic: system.updateClaudeSettingsForProvider,
    deepseek: system.updateDeepSeekHarnessConfig,
  }
  beforeEach(() => {
    vi.mocked(system.getRouterStatus).mockResolvedValue({ success: true, data: { enabled: false, running: false } })
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ router_enabled: false, sync_enabled: true })
  })
  it.each(['openai', 'anthropic', 'deepseek'] as const)('syncs %s edits before saving storage', async format => {
    const provider = { ...providers[0], format, model: 'before', routerActiveFormats: [] }
    vi.mocked(storage.getProviders).mockResolvedValue([provider])
    vi.mocked(writers[format]).mockResolvedValue({ success: true })
    vi.mocked(storage.updateProvider).mockResolvedValue({ ...provider, model: 'after' })
    expect((await send('UPDATE_PROVIDER', { id: provider.id, updates: { model: 'after' } })).success).toBe(true)
    expect(writers[format]).toHaveBeenCalledWith({ ...provider, model: 'after' })
    expect(vi.mocked(writers[format]).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(storage.updateProvider).mock.invocationCallOrder[0])
  })
  it('keeps storage unchanged when Harness synchronization fails', async () => {
    const provider = { ...providers[0], format: 'deepseek' as const, routerActiveFormats: [] }
    vi.mocked(storage.getProviders).mockResolvedValue([provider])
    vi.mocked(system.updateDeepSeekHarnessConfig).mockResolvedValue({ success: false, error: 'Invalid YAML' })
    expect(await send('UPDATE_PROVIDER', { id: provider.id, updates: { model: 'after' } })).toEqual({ success: false, error: 'Invalid YAML' })
    expect(storage.updateProvider).not.toHaveBeenCalled()
    expect(await send('SET_ACTIVE_PROVIDER', { id: provider.id })).toEqual({ success: false, error: 'Invalid YAML' })
    expect(storage.setActiveProvider).not.toHaveBeenCalled()
  })
  it('saves without writing Harness when automatic sync is disabled', async () => {
    const provider = { ...providers[0], format: 'deepseek' as const, routerActiveFormats: [] }
    vi.mocked(storage.getProviders).mockResolvedValue([provider])
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ router_enabled: false, sync_enabled: false })
    vi.mocked(storage.updateProvider).mockResolvedValue(provider)
    expect((await send('UPDATE_PROVIDER', { id: provider.id, updates: { model: 'after' } })).success).toBe(true)
    expect(system.updateDeepSeekHarnessConfig).not.toHaveBeenCalled()
  })
})
