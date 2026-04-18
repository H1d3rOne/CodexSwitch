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
    expect(background).toContain('const syncResult = await updateCodexSystemForProvider(current)')
    expect(background).toContain('if (!syncResult.success)')
    expect(background).toContain("return { success: false, error: syncResult.error || 'Codex system config sync failed' }")
  })

  it('surfaces sync errors to the popup when setting active provider', () => {
    const popup = readRelative('src/popup/App.tsx')
    expect(popup).toContain("SET_ACTIVE_PROVIDER', { id, sync: syncEnabled }")
    expect(popup).toContain('if (!res.success)')
    expect(popup).toContain("alert(`Set active succeeded but Codex sync failed: ${res.error || 'Unknown error'}`)")
  })
})
