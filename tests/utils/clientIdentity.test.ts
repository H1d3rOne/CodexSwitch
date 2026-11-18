import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyClientIdentity,
  buildRouterIdentityMap,
  CLIENT_PRESETS,
  DEFAULT_CLIENT_IDENTITY,
  getClientIdentity,
  identityHeadersForFormat,
  identityForFormat,
  normalizeClientIdentity,
  normalizeClientIdentitySettings,
  resolveClientIdentity,
  resolvePreset,
  saveClientIdentity,
  saveClientIdentitySettings,
  getClientIdentitySettings,
  stripSdkFingerprint,
} from '../../src/utils/clientIdentity'
import {
  buildClientIdentityRules,
  collectIdentityHosts,
  identityHost,
  syncClientIdentityRules,
} from '../../src/utils/clientIdentityRules'

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('client identity presets', () => {
  it('auto resolves the client that natively speaks each format', () => {
    expect(resolvePreset(DEFAULT_CLIENT_IDENTITY, 'openai')).toBe('codex')
    expect(resolvePreset(DEFAULT_CLIENT_IDENTITY, 'anthropic')).toBe('claude-code')
    expect(resolvePreset(DEFAULT_CLIENT_IDENTITY, 'deepseek')).toBe('deepseek-harness')
    expect(resolvePreset({ preset: 'opencode' }, 'anthropic')).toBe('opencode')
  })

  it('emits a versioned User-Agent plus companion headers for Codex', () => {
    const resolved = resolveClientIdentity({ preset: 'codex', version: '0.61.0' }, { protocol: 'chat', format: 'openai' })
    expect(resolved.userAgent).toBe('codex_cli_rs/0.61.0')
    expect(resolved.headers.originator).toBe('codex_cli_rs')
    expect(resolved.headers.version).toBe('0.61.0')
    expect(resolved.headers['openai-beta']).toBe('responses=experimental')
  })

  it('keeps the Anthropic wire headers for Messages traffic', () => {
    const resolved = resolveClientIdentity({ preset: 'codex' }, { protocol: 'messages', format: 'anthropic' })
    expect(resolved.headers['anthropic-version']).toBe('2023-06-01')
    expect(resolved.userAgent).toMatch(/^codex_cli_rs\//)
  })

  it('turns everything off for the off preset', () => {
    const resolved = resolveClientIdentity({ preset: 'off' }, { protocol: 'chat', format: 'openai' })
    expect(resolved.userAgent).toBeUndefined()
    expect(resolved.headers).toEqual({})
    expect(resolved.stripSdkHeaders).toBe(false)
  })

  it('lets a custom preset carry an arbitrary User-Agent and extra headers', () => {
    const resolved = resolveClientIdentity({
      preset: 'custom',
      userAgent: 'my-cli/9.9.9',
      extraHeaders: { 'x-team': 'lab' },
    }, { protocol: 'chat', format: 'openai' })
    expect(resolved.userAgent).toBe('my-cli/9.9.9')
    expect(resolved.headers).toEqual({ 'x-team': 'lab' })
  })

  it('applies identity without overwriting credentials or protocol headers', () => {
    const headers = applyClientIdentity(
      {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-local',
        'anthropic-version': '2023-06-01',
        'x-stainless-lang': 'js',
        'x-stainless-runtime': 'node',
      },
      { preset: 'claude-code' },
      { protocol: 'chat', format: 'anthropic' },
    )
    expect(headers.authorization ?? headers.Authorization).toBe('Bearer sk-local')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['User-Agent']).toMatch(/^claude-cli\//)
    expect(headers['x-app']).toBe('cli')
    expect(headers['x-stainless-lang']).toBeUndefined()
  })

  it('strips SDK fingerprint headers only', () => {
    expect(stripSdkFingerprint({ 'x-stainless-lang': 'js', 'x-sdk-version': '1', 'x-custom': 'keep', 'accept': 'application/json' }))
      .toEqual({ 'x-custom': 'keep', 'accept': 'application/json' })
  })

  it('normalizes unknown stored values back to the default', () => {
    expect(normalizeClientIdentity({ preset: 'not-a-preset' }).preset).toBe(DEFAULT_CLIENT_IDENTITY.preset)
    expect(normalizeClientIdentity('garbage').preset).toBe(DEFAULT_CLIENT_IDENTITY.preset)
    expect(normalizeClientIdentity({ preset: 'codex', extraHeaders: { a: 1, b: 'ok' } }).extraHeaders).toEqual({ b: 'ok' })
  })

  it('builds a per-format router map without protocol leakage', () => {
    const map = buildRouterIdentityMap({ preset: 'auto' })
    expect(map.openai?.userAgent).toMatch(/^codex_cli_rs\//)
    expect(map.anthropic?.userAgent).toMatch(/^claude-cli\//)
    expect(map.openai?.headers['anthropic-beta']).toBeUndefined()
    expect(map.anthropic?.messagesHeaders['anthropic-beta']).toContain('claude-code-')
    expect(identityHeadersForFormat({ preset: 'claude-code' }, 'anthropic', 'messages')['anthropic-version']).toBe('2023-06-01')
  })
})

describe('client identity storage', () => {
  function stubStorage() {
    const store: Record<string, unknown> = {}
    vi.stubGlobal('chrome', {
      storage: { local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(store, values) }),
      } },
    })
    return store
  }

  it('round-trips the default identity through chrome.storage.local', async () => {
    stubStorage()
    expect(await getClientIdentity()).toEqual(DEFAULT_CLIENT_IDENTITY)
    const saved = await saveClientIdentity({ preset: 'opencode', version: '0.16.0' })
    expect(saved.preset).toBe('opencode')
    expect((await getClientIdentity()).version).toBe('0.16.0')
  })

  it('keeps per-format overrides and falls back to the default', async () => {
    const store = stubStorage()
    await saveClientIdentitySettings(normalizeClientIdentitySettings({
      default: { preset: 'codex' },
      formatIdentities: { anthropic: { preset: 'claude-code', version: '2.1.0' } },
    }))
    const settings = await getClientIdentitySettings()
    expect(identityForFormat(settings, 'openai').preset).toBe('codex')
    expect(identityForFormat(settings, 'anthropic')).toEqual({ preset: 'claude-code', version: '2.1.0' })
    expect(identityForFormat(settings, 'deepseek').preset).toBe('codex')
    expect(identityForFormat(settings).preset).toBe('codex')
    expect(store.client_identity).toBeDefined()
  })

  it('normalizes malformed per-format entries away', () => {
    const settings = normalizeClientIdentitySettings({
      default: { preset: 'bogus' },
      formatIdentities: { openai: 'garbage', anthropic: { preset: 'off' }, deepseek: 42 },
    })
    expect(settings.default.preset).toBe(DEFAULT_CLIENT_IDENTITY.preset)
    expect(settings.formatIdentities.openai).toBeUndefined()
    expect(settings.formatIdentities.anthropic).toEqual({ preset: 'off' })
    expect(settings.formatIdentities.deepseek).toBeUndefined()
  })

  it('resolves the router map per format with overrides applied', async () => {
    const { buildRouterIdentityMap } = await import('../../src/utils/clientIdentity')
    const map = buildRouterIdentityMap({
      default: { preset: 'codex' },
      formatIdentities: { anthropic: { preset: 'claude-code', version: '2.1.0' } },
    })
    expect(map.openai?.userAgent).toMatch(/^codex_cli_rs\//)
    expect(map.anthropic?.userAgent).toBe('claude-cli/2.1.0')
    expect(map.anthropic?.messagesHeaders['anthropic-beta']).toBe('claude-code-2.1.0')
    expect(map.openai?.headers['anthropic-beta']).toBeUndefined()
  })
})

describe('legacy domain-rule migration', () => {
  it('removes broad managed rules without touching other rules', async () => {
    const updateDynamicRules = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('chrome', { declarativeNetRequest: {
      getDynamicRules: vi.fn().mockResolvedValue([{ id: 1 }, { id: 7100 }, { id: 7299 }]),
      updateDynamicRules,
    } })
    expect(await syncClientIdentityRules([{ baseUrl: 'https://relay.example/v1' }], { preset: 'codex' }))
      .toEqual({ ok: true, ruleCount: 0 })
    expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [7100, 7299], addRules: [] })
    expect(buildClientIdentityRules({ preset: 'codex' }, [{ host: 'relay.example' }])).toEqual([])
  })
})
