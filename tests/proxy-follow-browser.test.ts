// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(__dirname, '..')

function readRelative(file: string) {
  return readFileSync(path.join(projectRoot, file), 'utf8')
}

describe('browser-managed proxy mode', () => {
  it('does not use chrome.proxy settings or proxy_url storage', () => {
    const api = readRelative('src/utils/api.ts')
    const background = readRelative('src/background/index.ts')
    const popup = readRelative('src/popup/App.tsx')

    expect(api).not.toContain('chrome.proxy.settings')
    expect(api).not.toContain('withProxy')
    expect(api).not.toContain('parseProxyUrl')
    expect(background).not.toContain('proxy_url')
    expect(background).not.toContain('getProxyUrl')
    expect(popup).not.toContain('proxy_url')
    expect(popup).not.toContain('handleProxyChange')
  })
})
