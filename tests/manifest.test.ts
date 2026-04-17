// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '..')

describe('extension manifest', () => {
  it('includes nativeMessaging permission for Codex config sync', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(projectRoot, 'public', 'manifest.json'), 'utf8')
    ) as { permissions?: string[] }

    expect(manifest.permissions).toContain('nativeMessaging')
  })
})
