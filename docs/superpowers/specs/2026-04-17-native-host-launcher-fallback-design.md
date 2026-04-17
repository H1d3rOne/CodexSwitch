# Native Host Launcher Fallback Design

## Goal

Improve the generated native host launcher so it keeps working on the same machine even if the originally detected Node.js path changes later (for example after `nvm` upgrades or reinstalling Node).

## Scope

In scope:
- `native_host/install.sh`
- generated launcher behavior
- installer/uninstaller docs
- automated tests for launcher fallback behavior

Out of scope:
- changing `config.toml` replacement behavior
- packaging the host as a standalone binary
- eliminating the need to reinstall on a different computer
- Windows native messaging support

## Approaches considered

### A. Single absolute Node path
Keep today’s launcher behavior and execute only the Node path detected at install time.

- Pros: simplest implementation
- Cons: breaks when that path disappears; weak against `nvm` / reinstall changes

### B. Ordered Node fallback list (recommended)
Generate a launcher that tries multiple Node executables in order and executes the host script with the first usable one.

Candidate order:
1. Node path detected during installation
2. `/opt/homebrew/bin/node`
3. `/usr/local/bin/node`
4. `/usr/bin/node`
5. `command -v node` from current runtime environment

- Pros: robust on the same machine; small and reviewable change; no change to host script protocol
- Cons: still machine-specific; moving to a different computer still requires rerunning `install.sh`

### C. Standalone packaged binary
Replace the Node-based host with a packaged executable.

- Pros: least dependency on local Node install
- Cons: significantly more build/distribution complexity; not justified for current scope

## Chosen design

Use approach B.

`install.sh` will continue generating `codex_config_host_launcher.sh`, but the launcher will:
- embed the install-time Node path as the first candidate
- try a short list of common absolute Node paths
- finally try `command -v node` if available
- `exec` the first working candidate with `codex_config_host.cjs`
- print a concise error to stderr and exit non-zero if no Node executable is available

## Behavior details

### Launcher contract

Input/output behavior remains unchanged because the launcher only selects the Node executable and then delegates to:

```bash
exec "$node_bin" "$HOST_SCRIPT"
```

### Failure mode

If no candidate works, the launcher should emit one clear diagnostic line to stderr, indicating that Node could not be found and that rerunning `native_host/install.sh` may be required.

### Cross-machine expectation

This change improves resilience on the same computer only. A different computer should still run `native_host/install.sh` again to generate machine-local paths and manifest files.

## Testing strategy

1. Red test: install the launcher, then execute it with a restricted `PATH` and with the install-time Node path made unavailable; expect fallback to another Node path and a successful `ping` response.
2. Red test: execute the launcher in an environment where no candidate Node path exists; expect non-zero exit and a clear stderr message.
3. Verify existing success case still works.

## Files expected to change

- `native_host/install.sh`
- `native_host/uninstall.sh` (only if launcher handling changes need cleanup parity)
- `native_host/README.md`
- `tests/native_host.install.test.ts`

## Risks

- Quoting/path escaping mistakes inside generated shell scripts
- Assuming Node paths that do not exist on every platform
- Tests becoming too dependent on the current machine layout

## Mitigations

- Keep launcher shell logic minimal and quoted
- Limit fallback list to a few common paths plus runtime `command -v node`
- Structure tests so they control candidate paths through temporary wrapper executables rather than relying only on host machine state
