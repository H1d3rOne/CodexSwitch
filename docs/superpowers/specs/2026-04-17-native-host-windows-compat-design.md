# Native Host Windows Compatibility Design

## Goal

Add Windows support for the CodexSwitch native host so a Windows user can install, register, launch, and uninstall the native messaging host with behavior comparable to the existing macOS/Linux flow.

## Scope

In scope:
- Windows-specific install and uninstall scripts
- Windows native messaging manifest generation
- Windows registry registration under the current user hive
- Windows launcher executable to start `codex_config_host.cjs`
- README updates for Windows installation and troubleshooting
- Automated tests for generated Windows artifacts and launcher resolution logic where feasible in this repository

Out of scope:
- Replacing `codex_config_host.cjs` with a packaged standalone binary
- Admin/system-wide installation via `HKLM` by default
- End-to-end execution tests on a real Windows machine in this macOS session
- Changing the config/auth replacement semantics inside `codex_config_host.cjs`

## Evidence and constraints

Based on Chrome’s Native Messaging documentation:
- Windows requires a registry entry under `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<host-name>` or `HKLM\\...` that points to the manifest file path
- The manifest `path` should point to the native host executable

Sources:
- https://developer.chrome.com/docs/extensions/mv3/nativeMessaging
- https://developer.chrome.com/docs/apps/nativeMessaging

Because of that constraint, a Windows script-only host path is risky. The most reliable design is to provide a real Windows launcher executable and let it invoke Node plus the existing `.cjs` host script.

## Approaches considered

### A. Script-only Windows support
Use `install.ps1` / `uninstall.ps1`, registry registration, and point the manifest directly at a batch or PowerShell script.

- Pros: smallest code delta
- Cons: weaker confidence that Chrome will treat the script as a proper native host executable; quoting and shell startup behavior are more fragile
- Decision: not recommended

### B. Windows launcher executable plus PowerShell install/uninstall scripts (recommended)
Add a small Windows launcher executable that resolves `node.exe` and starts `codex_config_host.cjs`, while PowerShell handles manifest creation and registry registration.

- Pros: aligns with Chrome’s executable-path expectation; keeps existing host logic intact; isolates Windows-specific process startup concerns into one component
- Cons: introduces a small compiled Windows-specific artifact/source file
- Decision: recommended

### C. Package the entire host as a standalone Windows executable
Bundle the host logic and runtime into a single executable.

- Pros: least dependency on local Node installation
- Cons: substantially more build and release complexity; outside current scope
- Decision: defer

## Chosen design

Use approach B.

The Windows implementation will add:
- `native_host/install.ps1`
- `native_host/uninstall.ps1`
- Windows launcher source under `native_host/windows/`
- generated Windows manifest and registry entry under the current user hive

The existing `native_host/codex_config_host.cjs` remains the single source of host behavior.

## Architecture

### 1. Windows install flow

`install.ps1` will:
1. Prompt for the Chrome extension ID
2. Resolve the repository-local `codex_config_host.cjs`
3. Resolve or accept a `node.exe` location
4. Create a Windows manifest file for host name `codex_config_host`
5. Write the registry key under:
   - `HKCU:\Software\Google\Chrome\NativeMessagingHosts\codex_config_host`
6. Set the registry default value to the manifest absolute path
7. Print the generated paths and next steps

### 2. Windows uninstall flow

`uninstall.ps1` will:
- remove the `HKCU` registry entry for `codex_config_host`
- optionally remove the generated manifest file if it exists
- keep the repo source files intact

### 3. Windows launcher behavior

The Windows launcher executable will:
- receive no custom CLI protocol from Chrome beyond stdio host startup
- locate `node.exe` using an ordered candidate list
- start `node.exe <absolute path to codex_config_host.cjs>`
- inherit stdin/stdout/stderr so native messaging framing remains unchanged
- exit non-zero with a clear diagnostic if no usable `node.exe` is found

Candidate order:
1. install-time detected Node path embedded into the launcher or launcher-adjacent config
2. common user-install paths if practical
3. `where.exe node`

### 4. Windows manifest shape

The generated Windows manifest will keep:
- `name = codex_config_host`
- `type = stdio`
- `allowed_origins = ["chrome-extension://<id>/"]`

And its `path` will point to the Windows launcher executable.

## File layout

Planned files:
- Modify: `native_host/README.md`
- Add: `native_host/install.ps1`
- Add: `native_host/uninstall.ps1`
- Add: `native_host/windows/` launcher source file(s)
- Add/Modify: tests covering Windows artifact generation and launcher node-resolution logic

The Node-based host logic stays in:
- `native_host/codex_config_host.cjs`

## Error handling

### Install-time failures

`install.ps1` should fail clearly when:
- extension ID is empty
- `node.exe` cannot be found
- registry write fails
- manifest write fails

### Runtime failures

The Windows launcher should emit one concise stderr message if it cannot resolve `node.exe`, instructing the user to reinstall or provide a valid Node installation.

## Testing strategy

Because this session is not running on Windows, testing will be split:

1. Repository-local automated tests:
   - verify Windows manifest content generation
   - verify install-script templates or generated content
   - verify launcher node-resolution logic as pure logic/unit tests when possible
2. Documentation-level validation:
   - record exact Windows install/uninstall steps
   - document expected registry path and manifest layout
3. Deferred runtime validation:
   - on a real Windows machine, run `install.ps1`, confirm registry key, and verify the extension can ping the host

## Security and portability choices

- Default to `HKCU` instead of `HKLM` to avoid admin requirement
- Keep all generated paths machine-local; another Windows machine should rerun `install.ps1`
- Do not scan unrelated user secrets or system-wide stores beyond the specific registry path required for native messaging registration

## Risks

- Windows launcher implementation language/build choice may affect maintainability
- Quoting paths with spaces on Windows can be error-prone
- Without a live Windows environment, end-to-end runtime issues may remain undetected until manual validation

## Mitigations

- Keep the launcher minimal and focused on process startup only
- Use absolute paths everywhere in generated artifacts
- Document the exact registry location and verification steps
- Keep Windows support additive and isolated from existing macOS/Linux behavior

## Success criteria

A Windows user can:
1. Run `native_host/install.ps1`
2. Get a manifest file and `HKCU` registry registration for `codex_config_host`
3. Launch the native host through Chrome using the generated executable path
4. Run `native_host/uninstall.ps1` to remove the registration cleanly
