# Native Host Launcher Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generated native host launcher resilient to local Node.js path changes by trying multiple Node candidates before failing.

**Architecture:** Keep the existing Native Messaging contract unchanged. Only change the generated launcher shell script so it resolves a usable Node binary from an ordered fallback list, then `exec`s `codex_config_host.cjs`. Document the new behavior and verify both fallback success and no-Node failure in Node-environment Vitest tests.

**Tech Stack:** Bash, Node.js, Chrome Native Messaging, Vitest

---

## File map

- Modify: `native_host/install.sh` — generate a launcher with ordered Node fallback and clear stderr failure message.
- Modify: `native_host/README.md` — document fallback launcher behavior and updated manual-install snippet.
- Modify: `tests/native_host.install.test.ts` — cover fallback success and total failure cases.
- Optional modify: `native_host/uninstall.sh` — only if cleanup paths or filenames change (currently no behavior change needed).

### Task 1: Lock in fallback behavior with failing tests

**Files:**
- Modify: `tests/native_host.install.test.ts`
- Reference: `native_host/install.sh`

- [ ] **Step 1: Replace the current single success-case test with helper-driven tests**

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
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

function installInto(homeDir: string, pathValue?: string) {
  return spawnSync('bash', [installScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      ...(pathValue ? { PATH: pathValue } : {}),
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
```

- [ ] **Step 2: Add a red test for “install-time node path is gone, fallback still succeeds”**

```ts
it('falls back to another node binary when the install-time node path is unavailable', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-home-'))
  const installBinDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-install-bin-'))
  const fakeInstallNode = makeExecutable(
    path.join(installBinDir, 'node'),
    '#!/bin/bash\nexit 127\n'
  )

  const installResult = installInto(homeDir, `${installBinDir}:${process.env.PATH ?? ''}`)
  expect(installResult.status, installResult.stderr).toBe(0)

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
```

- [ ] **Step 3: Add a red test for “no candidate node exists”**

```ts
it('prints a clear error when no node candidate is available', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-home-'))
  const installBinDir = mkdtempSync(path.join(tmpdir(), 'codexswitch-install-bin-'))
  makeExecutable(
    path.join(installBinDir, 'node'),
    '#!/bin/bash\nexit 127\n'
  )

  const installResult = installInto(homeDir, `${installBinDir}:${process.env.PATH ?? ''}`)
  expect(installResult.status, installResult.stderr).toBe(0)

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
```

- [ ] **Step 4: Run the test file to verify RED**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.install.test.ts
```

Expected:
- First new test fails because launcher only executes the install-time `NODE_PATH`
- Second new test fails because current launcher does not emit the explicit error string

- [ ] **Step 5: Commit the red test changes**

```bash
git add tests/native_host.install.test.ts
git commit -m "test: cover native host launcher fallback"
```

### Task 2: Generate a launcher with ordered Node fallback

**Files:**
- Modify: `native_host/install.sh`
- Reference: `tests/native_host.install.test.ts`

- [ ] **Step 1: Replace the current generated launcher body with candidate-based resolution**

Update the launcher heredoc in `native_host/install.sh` to this shape:

```bash
cat > "$LAUNCHER_FILE" << EOF
#!/bin/bash
HOST_SCRIPT="$HOST_SCRIPT"

NODE_CANDIDATES=(
  "$NODE_PATH"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
  "/usr/bin/node"
)

for node_bin in "${NODE_CANDIDATES[@]}"; do
  if [ -x "$node_bin" ]; then
    exec "$node_bin" "$HOST_SCRIPT"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$HOST_SCRIPT"
fi

echo "[CodexSwitch] Node.js executable not found; please reinstall native_host/install.sh" >&2
exit 127
EOF
```

- [ ] **Step 2: Keep the rest of the installer behavior unchanged**

Ensure these lines remain intact:

```bash
chmod +x "$HOST_SCRIPT"
chmod +x "$LAUNCHER_FILE"
```

and keep manifest generation pointing to the launcher:

```json
{
  "name": "codex_config_host",
  "description": "CodexSwitch Config Sync Host",
  "path": "$LAUNCHER_FILE",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
```

- [ ] **Step 3: Run the focused test file to verify GREEN**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.install.test.ts
```

Expected:
- All tests in `tests/native_host.install.test.ts` pass

- [ ] **Step 4: Commit the launcher implementation**

```bash
git add native_host/install.sh tests/native_host.install.test.ts
git commit -m "fix: add native host launcher node fallbacks"
```

### Task 3: Document the new launcher behavior

**Files:**
- Modify: `native_host/README.md`
- Verify: `native_host/uninstall.sh`

- [ ] **Step 1: Update the manual launcher example to show fallback behavior**

Edit the launcher example in `native_host/README.md` to:

```bash
#!/bin/bash
HOST_SCRIPT="/绝对路径/到/codex_config_host.cjs"

for node_bin in \
  "/绝对路径/到/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node"
do
  if [ -x "$node_bin" ]; then
    exec "$node_bin" "$HOST_SCRIPT"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec "$(command -v node)" "$HOST_SCRIPT"
fi

echo "[CodexSwitch] Node.js executable not found; please reinstall native_host/install.sh" >&2
exit 127
```

- [ ] **Step 2: Add one sentence documenting the portability expectation**

Add near the install or troubleshooting section:

```md
该 launcher 会优先使用安装时探测到的 Node.js 路径，并在其失效时回退到常见 Node 路径；换到另一台电脑时仍建议重新运行 `./install.sh`。
```

- [ ] **Step 3: Verify docs remain aligned with current uninstall behavior**

Check that `native_host/uninstall.sh` still removes:
- `codex_config_host.json`
- `codex_config_host_launcher.sh`

If those filenames remain unchanged, do not edit `native_host/uninstall.sh`.

- [ ] **Step 4: Run focused verification again after doc edits**

Run:
```bash
TMPDIR=/tmp npx vitest run tests/native_host.install.test.ts
```

Expected:
- Test file still passes unchanged

- [ ] **Step 5: Commit the documentation update**

```bash
git add native_host/README.md
git commit -m "docs: describe native host launcher fallback"
```

## Final verification checklist

- [ ] Run the focused automated tests:

```bash
TMPDIR=/tmp npx vitest run tests/native_host.install.test.ts
```

Expected: the launcher test file passes with all tests green.

- [ ] Manually verify a generated launcher on a temp HOME:

```bash
tmp_home=$(mktemp -d /tmp/codexswitch-verify.XXXXXX)
HOME="$tmp_home" bash native_host/install.sh <<'EOF'
abcdefghijklmnopabcdefghijklmnop
EOF
cat "$tmp_home/Library/Application Support/Google/Chrome/NativeMessagingHosts/codex_config_host_launcher.sh"
```

Expected:
- Launcher contains the install-time `NODE_PATH`
- Launcher also contains `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`
- Launcher ends with the explicit stderr error and `exit 127`
