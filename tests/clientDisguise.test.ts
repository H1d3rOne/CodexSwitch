import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildRouterDisguiseMap,
  normalizeClientDisguiseSettings,
  CLIENT_DISGUISE_STORAGE_KEY,
  getClientDisguiseSettings,
  saveClientDisguiseSettings,
} from '../src/utils/clientIdentity'

describe('client disguise settings', () => {
  it('normalizes entries per entry-client format and drops malformed ones', () => {
    const normalized = normalizeClientDisguiseSettings({
      openai: { preset: 'claude-code', version: '2.0.0' },
      anthropic: { preset: 'deepseek-harness' },
      deepseek: 'not-an-object',
      extra: { preset: 'codex' },
    })
    expect(Object.keys(normalized).sort()).toEqual(['anthropic', 'openai'])
    expect(normalized.openai).toEqual({ preset: 'claude-code', version: '2.0.0' })
    expect(normalized.anthropic).toEqual({ preset: 'deepseek-harness' })
  })

  it('reads and writes the client_disguise storage key', async () => {
    const store: Record<string, unknown> = {}
    ;(globalThis as any).chrome = {
      storage: { local: {
        get: vi.fn(async (key: string) => key === CLIENT_DISGUISE_STORAGE_KEY ? { [key]: store[key] } : {}),
        set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(store, update) }),
      } },
    }
    const saved = await saveClientDisguiseSettings({ openai: { preset: 'opencode' } })
    expect(saved).toEqual({ openai: { preset: 'opencode' } })
    expect(store[CLIENT_DISGUISE_STORAGE_KEY]).toEqual({ openai: { preset: 'opencode' } })
    expect(await getClientDisguiseSettings()).toEqual({ openai: { preset: 'opencode' } })
    delete (globalThis as any).chrome
  })
})

describe('buildRouterDisguiseMap', () => {
  it('is empty when nothing is configured or every entry is off', () => {
    expect(buildRouterDisguiseMap()).toEqual({})
    expect(buildRouterDisguiseMap({ openai: { preset: 'off' }, anthropic: { preset: 'off' } })).toEqual({})
  })

  it('builds a distinct identity per entry-client, keyed by the entry namespace', () => {
    const map = buildRouterDisguiseMap({
      openai: { preset: 'claude-code', version: '2.0.76' },
      anthropic: { preset: 'deepseek-harness' },
      deepseek: { preset: 'codex', version: '0.61.0' },
    })
    expect(Object.keys(map).sort()).toEqual(['anthropic', 'deepseek', 'openai'])
    // openai entry impersonates Claude Code (anthropic-* headers go to messagesHeaders)
    expect(map.openai!.userAgent).toBe('claude-cli/2.0.76')
    expect(map.openai!.headers).toMatchObject({ 'x-app': 'cli' })
    expect(map.openai!.messagesHeaders).toMatchObject({ 'anthropic-beta': 'claude-code-2.0.76' })
    // anthropic entry impersonates DeepSeek Harness
    expect(map.anthropic!.userAgent).toBe('deepseek-harness/0.61.0')
    expect(map.anthropic!.headers).toMatchObject({ 'x-client-name': 'deepseek-harness' })
    // deepseek entry impersonates Codex CLI
    expect(map.deepseek!.userAgent).toBe('codex_cli_rs/0.61.0')
    expect(map.deepseek!.headers).toMatchObject({ 'x-client-name': 'codex_cli_rs', 'originator': 'codex_cli_rs' })
  })

  it('merges anthropic protocol headers into messagesHeaders', () => {
    const map = buildRouterDisguiseMap({ openai: { preset: 'codex', version: '1' } })
    expect(map.openai!.messagesHeaders).toMatchObject({ 'anthropic-version': '2023-06-01' })
    expect(map.openai!.headers['anthropic-version']).toBeUndefined()
  })

  it('honors a custom UA and extra headers', () => {
    const map = buildRouterDisguiseMap({ openai: { preset: 'custom', userAgent: 'my-agent/9', extraHeaders: { 'x-team': 'lab' } } })
    expect(map.openai!.userAgent).toBe('my-agent/9')
    expect(map.openai!.headers).toMatchObject({ 'x-team': 'lab' })
  })
})

afterEach(() => { delete (globalThis as any).chrome })
