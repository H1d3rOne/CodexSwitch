import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'

function runNativeHost(homeDir: string, message: unknown) {
  const scriptPath = path.resolve('native_host/codex_config_host.cjs')
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(payload.length, 0)
  const input = Buffer.concat([length, payload])

  const result = spawnSync(process.execPath, [scriptPath], {
    input,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    encoding: null,
  })

  expect(result.status).toBe(0)
  expect(result.stdout.length).toBeGreaterThanOrEqual(4)

  const outputLength = result.stdout.readUInt32LE(0)
  const outputJson = result.stdout.subarray(4, 4 + outputLength).toString('utf8')
  return JSON.parse(outputJson)
}

describe('native host config sync', () => {
  it('keeps model_provider unchanged and updates the active provider section fields in config.toml', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-host-'))
    const codexDir = path.join(homeDir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })

    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      [
        'model_provider = "OpenAI"',
        'model = "gpt-4"',
        '',
        '[model_providers.OpenAI]',
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        '',
        '[projects."C:\\work"]',
        'trust_level = "trusted"',
        '',
      ].join('\n'),
      'utf8'
    )

    const response = runNativeHost(homeDir, {
      action: 'updateConfig',
      config: {
        name: 'AzureOpenAI',
        baseUrl: 'https://example.azure.com/openai/v1',
        apiKey: 'sk-test',
        model: 'gpt-4.1',
      },
    })

    expect(response).toEqual({ success: true })

    const configToml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')
    expect(configToml).toContain('model_provider = "OpenAI"')
    expect(configToml).toContain('model = "gpt-4.1"')
    expect(configToml).toContain('[model_providers.OpenAI]')
    expect(configToml).not.toContain('[model_providers.AzureOpenAI]')
    expect(configToml).toContain('name = "AzureOpenAI"')
    expect(configToml).toContain('base_url = "https://example.azure.com/openai/v1"')
    expect(configToml.match(/^model = /gm)).toHaveLength(1)
    expect(configToml.match(/^\s*name = /gm)).toHaveLength(1)
    expect(configToml.match(/^\s*base_url = /gm)).toHaveLength(1)
    expect(configToml).toContain('[projects."C:\\work"]')

    const authJson = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'))
    expect(authJson.OPENAI_API_KEY).toBe('sk-test')
  })

  it('can rewrite a read-only config.toml by fixing permissions before retrying', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-host-'))
    const codexDir = path.join(homeDir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })

    const configPath = path.join(codexDir, 'config.toml')
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "OpenAI"',
        'model = "gpt-4"',
        '',
        '[model_providers.OpenAI]',
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        '',
      ].join('\n'),
      'utf8'
    )
    fs.chmodSync(configPath, 0o444)

    const response = runNativeHost(homeDir, {
      action: 'updateConfig',
      config: {
        name: 'RetryProvider',
        baseUrl: 'https://retry.example.com/v1',
        apiKey: 'sk-retry',
        model: 'gpt-4.1-mini',
      },
    })

    expect(response).toEqual({ success: true })

    const configToml = fs.readFileSync(configPath, 'utf8')
    expect(configToml).toContain('model_provider = "OpenAI"')
    expect(configToml).toContain('[model_providers.OpenAI]')
    expect(configToml).toContain('name = "RetryProvider"')
    expect(configToml).toContain('base_url = "https://retry.example.com/v1"')
  })

  it('initializes config.toml when missing', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-host-'))
    const response = runNativeHost(homeDir, {
      action: 'updateConfig',
      config: {
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-created',
        model: 'gpt-5',
      },
    })

    expect(response).toEqual({ success: true })

    const configToml = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8')
    expect(configToml).toContain('model_provider = "OpenAI"')
    expect(configToml).toContain('model = "gpt-5"')
    expect(configToml).toContain('[model_providers.OpenAI]')
    expect(configToml).toContain('name = "OpenAI"')
    expect(configToml).toContain('base_url = "https://api.openai.com/v1"')
  })
})
