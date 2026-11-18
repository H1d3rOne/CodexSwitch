// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '..')

function readRelative(file: string) {
  return readFileSync(path.join(projectRoot, file), 'utf8')
}

describe('Codex sync error propagation', () => {
  it('does not swallow native host sync failures in background', () => {
    const background = readRelative('src/background/index.ts')
    expect(background).toContain('await updateClaudeSettingsForProvider(current)')
    expect(background).toContain('await updateCodexSystemForProvider(current)')
    expect(background).toContain('if (!syncResult.success)')
    expect(background).toContain("return { success: false, error: syncResult.error || 'Config sync failed' }")
  })

  it('surfaces sync errors to the popup when setting active provider', () => {
    const popup = readRelative('src/popup/App.tsx')
    expect(popup).toContain("SET_ACTIVE_PROVIDER', { id, sync: syncEnabled,")
    expect(popup).toContain('if (!res.success)')
    expect(popup).toContain("alert(`Could not activate provider: ${res.error || 'Unknown error'}`)")
  })

  it('keeps model-test routing separate from global router and provider updates', () => {
    const background = readRelative('src/background/index.ts')
    expect(background).toContain("case 'TEST_MODEL_VIA_ROUTER':")
    const handler = background.split('async function handleTestModelViaRouter(')[1].split('async function handleTestProvider(')[0]
    expect(handler).toContain("chrome.storage.local.get('routerProxy')")
    expect(handler).toContain('return testModelViaRouter(provider,')
    for (const operation of ['updateProvider(', 'getProviders(', 'enableLocalRouter(', 'updateLocalRouterProvider(', 'storage.local.set(']) {
      expect(handler).not.toContain(operation)
    }
  })

  it('syncs active provider conversion changes before persisting them and surfaces failures', () => {
    const background = readRelative('src/background/index.ts')
    const handler = background.split('async function handleUpdateProvider(')[1].split('async function handleDeleteProvider(')[0]
    expect(handler).toContain("Object.keys(payload.updates).some")
    expect(handler).toContain('selectRouterProvider(providers, format)?.id === current.id')
    expect(handler).toContain('if (routerEnabled)')
    expect(handler).toContain('await updateLocalRouterProvider(next, targetFormat)')
    expect(handler).toContain('if (!routeResult.success)')
    expect(handler).toContain("return { success: false, error: routeResult.error || 'Router provider update failed' }")
    expect(handler.indexOf('await updateLocalRouterProvider(')).toBeLessThan(handler.indexOf('await updateProvider('))
  })
})
