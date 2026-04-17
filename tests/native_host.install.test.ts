// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = path.resolve(__dirname, '..')
const installScript = path.join(projectRoot, 'native_host', 'install.sh')

function encodeNativeMessage(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function decodeNativeMessage(output: Buffer) {
  const length = output.readUInt32LE(0)
  return JSON.parse(output.slice(4, 4 + length).toString('utf8'))
}

function makeExecutable(file: string, body: string) {
  writeFileSync(file, body, 'utf8')
  chmodSync(file, 0o755)
  return file
}

function installInto(homeDir: string, pathValue: string) {
  return spawnSync('bash', [installScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: pathValue,
    },
    input: 'abcdefghijklmnopabcdefghijklmnop\n',
    encoding: 'utf8',
  })
}

function readManifest(homeDir: string) {
  const manifestPath = path.join(
    homeDir,
    'Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host.json'
  )
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as { path: string }
}

describe('native_host/install.sh', () => {
  it('falls back to another node binary when the install-time node path is unavailable', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-home-'))
    const installBinDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-install-bin-'))
    const fakeInstallNode = makeExecutable(
      path.join(installBinDir, 'node'),
      '#!/bin/bash\nexit 0\n'
    )

    const installResult = installInto(homeDir, `${installBinDir}:${process.env.PATH ?? ''}`)
    expect(installResult.status, installResult.stderr).toBe(0)

    rmSync(fakeInstallNode)

    const manifest = readManifest(homeDir)
    const fallbackBinDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-fallback-bin-'))
    makeExecutable(
      path.join(fallbackBinDir, 'node'),
      `#!/bin/bash\nexec "${process.execPath}" "$@"\n`
    )

    const runResult = spawnSync(manifest.path, {
      cwd: projectRoot,
      env: {
        HOME: homeDir,
        PATH: `${fallbackBinDir}:/usr/bin:/bin`,
      },
      input: encodeNativeMessage({ action: 'ping' }),
      encoding: 'buffer',
    })

    expect(runResult.status, runResult.stderr?.toString()).toBe(0)
    expect(decodeNativeMessage(runResult.stdout)).toEqual({ success: true, pong: true })
  })

  it('prints a clear error when no node candidate is available', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-home-'))
    const installBinDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-install-bin-'))
    const fakeInstallNode = makeExecutable(
      path.join(installBinDir, 'node'),
      '#!/bin/bash\nexit 0\n'
    )

    const installResult = installInto(homeDir, `${installBinDir}:${process.env.PATH ?? ''}`)
    expect(installResult.status, installResult.stderr).toBe(0)

    rmSync(fakeInstallNode)

    const manifest = readManifest(homeDir)
    const runResult = spawnSync(manifest.path, {
      cwd: projectRoot,
      env: {
        HOME: homeDir,
        PATH: '/nonexistent',
      },
      input: encodeNativeMessage({ action: 'ping' }),
      encoding: 'buffer',
    })

    expect(runResult.status).not.toBe(0)
    expect(runResult.stderr.toString()).toContain('Node.js executable not found')
  })
})
