// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const { updateDeepSeekHarnessConfig, render, resolveDeepSeekHarnessPaths } = require('../native_host/src/deepseek_config.cjs')
const roots: string[] = []
const config = { providerId: 'test-provider', name: 'Test Provider', baseUrl: 'https://gateway.test/prefix/v1/', apiKey: 'test-secret', model: 'model-a', models: ['model-a'], api: 'openai-completions' }
const routerConfig = {
  router: true, providerId: 'codexswitch-router', baseUrl: 'http://127.0.0.1:15721/deepseek/v1',
  api: 'openai-completions', apiKey: 'local-token', apiKeyEnv: 'CODEXSWITCH_ROUTER_KEY', providerKey: 'router', models: ['router'], model: 'router',
}
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexswitch-dsh-'))
  roots.push(root)
  return root
}
function profile(extra: Record<string, unknown> = {}) {
  return render({ ...config, ...extra }, '', '')
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('DeepSeek Harness configuration', () => {
  it('defaults to the desktop profile and writes the selected protocol into the first provider', () => {
    expect(resolveDeepSeekHarnessPaths({ dshHome: '/tmp/dsh-home' }).patchFile).toBe('/tmp/dsh-home/profiles/desktop/cordis.patch.yml')
    const { patch } = profile({ api: 'anthropic-messages' })
    expect(YAML.parse(patch)).toEqual([
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'test-provider': {
        displayName: 'Test Provider', api: 'anthropic-messages', baseURL: 'https://gateway.test/prefix',
        apiKeyEnv: 'DEFAULT_API_KEY', models: [{ id: 'model-a', name: 'model-a' }],
      } } } },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'test-provider', model: 'model-a' } },
    ])
  })

  it('writes router values into the same first entry and keeps unrelated providers', () => {
    const base = `- id: llm-pi-ai
  config:
    providers:
      default:
        displayName: default
        apiKeyEnv: DEFAULT_API_KEY
        api: openai-completions
        baseURL: https://upstream.test/v1
        models: [{id: model-a}]
      nanguo: {displayName: nanguo, apiKeyEnv: NANGUO_API_KEY, api: openai-completions, baseURL: https://n.test/v1, models: [{id: m}]}
- id: agent-default-model
  config: {provider: nanguo, model: m}
`
    const result = render(routerConfig, base, 'version: 1\nrefs: {NANGUO_API_KEY: keep}\n')
    const doc: any = YAML.parse(result.patch)
    expect(Object.keys(doc[0].config.providers)).toEqual(['router', 'nanguo'])
    expect(doc[0].config.providers.router).toEqual({
      displayName: 'router', apiKeyEnv: 'CODEXSWITCH_ROUTER_KEY', api: 'openai-completions',
      baseURL: 'http://127.0.0.1:15721/deepseek/v1', models: [{ id: 'router', name: 'router' }],
    })
    expect(doc[1].config).toEqual({ provider: 'router', model: 'router' })
    expect(YAML.parse(result.credentials)).toEqual({ version: 1, refs: { NANGUO_API_KEY: 'keep', CODEXSWITCH_ROUTER_KEY: 'local-token' } })
  })

  it('drops the per-protocol entries written by earlier builds', () => {
    const base = `- id: llm-pi-ai
  config:
    providers:
      test-provider-openai-completions: {api: openai-completions, models: [{id: model-a}]}
      test-provider-openai-responses: {api: openai-responses, models: [{id: model-a}]}
      test-provider-anthropic-messages: {api: anthropic-messages, models: [{id: model-a}]}
      codexswitch-router: {api: openai-completions, models: [{id: router}]}
      other: {api: openai-completions, apiKeyEnv: OTHER_KEY}
- id: agent-default-model
  config: {provider: test-provider-anthropic-messages, model: model-a}
`
    const direct = render(config, base, '')
    const providers = YAML.parse(direct.patch)[0].config.providers
    expect(Object.keys(providers)).toEqual(['test-provider', 'other'])
    expect(providers.other.apiKeyEnv).toBe('OTHER_KEY')
    expect(YAML.parse(direct.patch)[1].config).toEqual({ provider: 'test-provider', model: 'model-a' })
    const viaRouter = render({ ...routerConfig, providerId: 'test-provider' }, direct.patch, direct.credentials)
    expect(Object.keys(YAML.parse(viaRouter.patch)[0].config.providers)).toEqual(['router', 'other'])
  })

  it('preserves comments, JS tags, model metadata, and unrelated providers', () => {
    const original = `# keep this comment
- id: llm-pi-ai
  config:
    providers:
      first:
        headers: {x-custom: preserve}
        models:
          - id: model-a
            contextWindow: 123456
            compat: {supportsStore: false}
      unrelated: {api: openai-responses, apiKeyEnv: OTHER_KEY}
- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        custom: !!js process.env.EXAMPLE
        providers:
          custom: {api: openai-responses, apiKeyEnv: CUSTOM_KEY}
    - id: agent-default-model
      config: {provider: old, model: old, reasoning: high}
`
    const result = render(config, original, 'version: 1\nrefs: {OTHER_KEY: keep}\n')
    const doc: any = YAML.parseDocument(result.patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }).toJS()
    expect(result.patch).toContain('# keep this comment')
    expect(result.patch).toContain('!!js process.env.EXAMPLE')
    expect(doc[0].config.providers.first).toMatchObject({ headers: { 'x-custom': 'preserve' }, models: [{ id: 'model-a', contextWindow: 123456, compat: { supportsStore: false } }] })
    // The first provider inside the active llm-pi-ai plugin is the managed one, even when nested in `insert`.
    expect(Object.keys(doc[1].insert[0].config.providers)).toEqual(['test-provider'])
    expect(doc[1].insert[0].config.providers['test-provider']).toMatchObject({ api: 'openai-completions', baseURL: 'https://gateway.test/prefix/v1', models: [{ id: 'model-a' }] })
    expect(doc[1].insert[1].config).toEqual({ provider: 'test-provider', model: 'model-a', reasoning: 'high' })
    expect(YAML.parse(result.credentials).refs.OTHER_KEY).toBe('keep')
  })

  it('reuses DEFAULT_API_KEY for every direct provider and only clears that shared credential', () => {
    const first = render(config, '', '')
    const second = render({ ...config, providerId: 'another', apiKey: 'another-secret' }, first.patch, first.credentials)
    expect(YAML.parse(second.credentials).refs).toEqual({ DEFAULT_API_KEY: 'another-secret' })
    // Router mode keeps its own credential slot, untouched by a direct switch.
    const viaRouter = render({ ...routerConfig, apiKey: 'local-token' }, second.patch, second.credentials)
    expect(YAML.parse(viaRouter.credentials).refs).toEqual({ DEFAULT_API_KEY: 'another-secret', CODEXSWITCH_ROUTER_KEY: 'local-token' })
    const cleared = render({ ...config, clearCredentials: true }, viaRouter.patch, viaRouter.credentials)
    expect(YAML.parse(cleared.credentials).refs).toEqual({ CODEXSWITCH_ROUTER_KEY: 'local-token' })
  })

  it('rejects an unselected model and unknown protocols', () => {
    expect(() => render({ ...config, model: 'missing' }, '', '')).toThrow('Selected DeepSeek model')
    expect(() => render({ ...config, api: 'grpc' }, '', '')).toThrow('Unsupported DeepSeek Harness protocol')
    expect(() => render({ ...config, baseUrl: 'ftp://nope' }, '', '')).toThrow('http or https')
  })

  it.each([
    ['providers: {}\n', 'version: 1\nrefs: {}\n'],
    ['- id: llm-pi-ai\n  id: duplicate\n', 'version: 1\nrefs: {}\n'],
    ['[]\n', 'version: 1\nrefs: {key: a, key: b}\n'],
    ['[]\n', 'version: 2\nrefs: {}\n'],
  ])('rejects invalid YAML without modifying either file', (patch, credentials) => {
    const dshHome = home()
    const paths = resolveDeepSeekHarnessPaths({ dshHome })
    fs.mkdirSync(path.dirname(paths.patchFile), { recursive: true })
    fs.writeFileSync(paths.patchFile, patch)
    fs.writeFileSync(paths.credentialsFile, credentials)
    expect(() => updateDeepSeekHarnessConfig({ ...config, dshHome })).toThrow()
    expect(fs.readFileSync(paths.patchFile, 'utf8')).toBe(patch)
    expect(fs.readFileSync(paths.credentialsFile, 'utf8')).toBe(credentials)
  })

  it('rolls back both files if the second atomic rename fails', () => {
    const dshHome = home()
    const paths = resolveDeepSeekHarnessPaths({ dshHome })
    fs.mkdirSync(path.dirname(paths.patchFile), { recursive: true })
    fs.writeFileSync(paths.patchFile, '# original\n[]\n')
    fs.writeFileSync(paths.credentialsFile, 'version: 1\nrefs: {}\n')
    const rename = fs.renameSync.bind(fs)
    let failed = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === paths.credentialsFile && !failed) { failed = true; throw new Error('injected rename failure') }
      return rename(source, target)
    })
    expect(() => updateDeepSeekHarnessConfig({ ...config, dshHome })).toThrow('injected rename failure')
    expect(fs.readFileSync(paths.patchFile, 'utf8')).toBe('# original\n[]\n')
    expect(fs.readFileSync(paths.credentialsFile, 'utf8')).toBe('version: 1\nrefs: {}\n')
  })

  it('writes private credentials and keeps the API key out of the patch file', () => {
    const dshHome = home()
    const result = updateDeepSeekHarnessConfig({ ...config, dshHome })
    expect(result.success).toBe(true)
    expect(YAML.parse(fs.readFileSync(result.data.credentialsFile, 'utf8'))).toEqual({
      version: 1, refs: { [result.data.providers[0].apiKeyEnv]: 'test-secret' },
    })
    expect(fs.statSync(result.data.credentialsFile).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(result.data.patchFile, 'utf8')).not.toContain('test-secret')
  })

  it('strips com.apple.quarantine from written files so Gatekeeper can open them', () => {
    const dshHome = home()
    for (const file of [path.join(dshHome, 'profiles/desktop/cordis.patch.yml'), path.join(dshHome, '.credentials.yaml')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '')
      try { fs.setxattrSync(file, 'com.apple.quarantine', Buffer.from('0081;0;Chrome;')); }
      catch { return; } // non-macOS platforms cannot set the attribute; skip the assertion
    }
    updateDeepSeekHarnessConfig({ ...config, dshHome })
    for (const file of [path.join(dshHome, 'profiles/desktop/cordis.patch.yml'), path.join(dshHome, '.credentials.yaml')]) {
      expect(() => fs.readFileSync(file, { encoding: 'buffer' }) && (fs as any).getxattrSync(file, 'com.apple.quarantine')).toThrow()
    }
  })

  it('removes stale CODEXSWITCH_DSH credentials left by earlier builds', () => {
    const stale = 'CODEXSWITCH_DSH_F7DDD504D72805E630985997'
    const result = render(config, '', `version: 1\nrefs:\n  ${stale}: old-key\n  OTHER_KEY: keep\n`)
    expect(YAML.parse(result.credentials).refs).toEqual({ OTHER_KEY: 'keep', DEFAULT_API_KEY: 'test-secret' })
    expect(result.patch).not.toContain(stale)
  })

  it('supports an explicit profile and rejects traversal', () => {
    const dshHome = home()
    expect(resolveDeepSeekHarnessPaths({ dshHome, profile: 'cli' }).patchFile).toBe(path.join(dshHome, 'profiles/cli/cordis.patch.yml'))
    expect(() => resolveDeepSeekHarnessPaths({ dshHome, profile: '../other' })).toThrow('profile')
  })

  it('runs the shipped standalone bundle without repository dependencies', () => {
    const root = home()
    const bundle = path.join(root, 'deepseek_config.cjs')
    fs.copyFileSync(path.resolve('native_host/deepseek_config.cjs'), bundle)
    const script = `const writer = require(${JSON.stringify(bundle)}); writer.updateDeepSeekHarnessConfig(${JSON.stringify({ ...config, dshHome: root })});`
    const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(fs.existsSync(path.join(root, 'profiles/desktop/cordis.patch.yml'))).toBe(true)
  })
})
