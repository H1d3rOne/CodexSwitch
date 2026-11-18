#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const AUTH_JSON = path.join(CODEX_DIR, 'auth.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CODEXSWITCH_DIR = path.join(os.homedir(), '.codexswitch');
const ROUTER_STATE = path.join(CODEXSWITCH_DIR, 'router-state.json');
const ROUTER_TOKEN = path.join(CODEXSWITCH_DIR, 'router-token.json');
const ROUTER_PID = `${ROUTER_STATE}.pid`;
const ROUTER_BACKUP_DIR = path.join(CODEXSWITCH_DIR, 'router-backup');
const ROUTER_BACKUP_MANIFEST = path.join(ROUTER_BACKUP_DIR, 'manifest.json');

function readSync() {
  const lengthBuf = Buffer.alloc(4);
  const bytesRead = fs.readSync(0, lengthBuf, 0, 4, null);
  if (bytesRead < 4) return null;

  const length = lengthBuf.readUInt32LE(0);
  const messageBuf = Buffer.alloc(length);
  fs.readSync(0, messageBuf, 0, length, null);
  return JSON.parse(messageBuf.toString('utf8'));
}

function writeSync(message) {
  const encoded = Buffer.from(JSON.stringify(message), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(encoded.length, 0);
  fs.writeSync(1, length);
  fs.writeSync(1, encoded);
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function detectEol(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function toLines(content) {
  return content.length > 0 ? content.split(/\r?\n/) : [];
}

function fromLines(lines, eol) {
  return lines.join(eol).replace(new RegExp(`${eol}+$`), '') + eol;
}

function upsertTopLevelField(lines, field, value) {
  const fieldLine = `${field} = "${escapeTomlString(value)}"`;
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < searchEnd; i += 1) {
    if (new RegExp(`^\\s*${field}\\s*=`).test(lines[i])) {
      lines[i] = fieldLine;
      return;
    }
  }

  lines.splice(searchEnd, 0, fieldLine);
}

function readTopLevelField(lines, field) {
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < searchEnd; i += 1) {
    const match = lines[i].match(new RegExp(`^\\s*${field}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|'([^']*)')\\s*$`));
    if (match) {
      if (match[1] !== undefined) {
        return match[1]
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return match[2];
    }
  }

  return null;
}

function formatProviderSectionHeader(name) {
  return /^[A-Za-z0-9_-]+$/.test(name)
    ? `[model_providers.${name}]`
    : `[model_providers."${escapeTomlString(name)}"]`;
}

function upsertProviderSection(lines, sectionKey, providerName, baseUrl, extraFields = {}, removeFields = []) {
  const header = formatProviderSectionHeader(sectionKey);
  const start = lines.findIndex(line => line.trim() === header);
  const fieldValues = new Map([
    ['name', `"${escapeTomlString(providerName)}"`],
    ['base_url', `"${escapeTomlString(baseUrl)}"`],
    ...Object.entries(extraFields),
  ]);
  const sectionLines = Array.from(fieldValues, ([field, value]) => `${field} = ${value}`);

  if (start === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(header, ...sectionLines);
    return;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end += 1;
  }

  let existingBody = lines.slice(start + 1, end);
  if (removeFields.length > 0) {
    const removePattern = new RegExp(`^\\s*(?:${removeFields.join('|')})\\s*=`);
    existingBody = existingBody.filter(line => !removePattern.test(line));
  }
  for (const [field, value] of fieldValues) {
    const replacement = `${field} = ${value}`;
    const idx = existingBody.findIndex(line => new RegExp(`^\\s*${field}\\s*=`).test(line));
    if (idx === -1) {
      existingBody.push(replacement);
    } else {
      existingBody[idx] = replacement;
    }
  }

  lines.splice(start, end - start, header, ...existingBody);
}

function providerSectionExists(lines, sectionKey) {
  return lines.some(line => line.trim() === formatProviderSectionHeader(sectionKey));
}


function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function clearReadonlyAttribute(filePath) {
  if (!fs.existsSync(filePath)) return;

  try {
    fs.chmodSync(filePath, 0o666);
  } catch {}

  if (process.platform === 'win32') {
    try {
      spawnSync('attrib', ['-R', filePath], { stdio: 'ignore', windowsHide: true });
    } catch {}
  }
}

function writeFileAtomically(filePath, content) {
  const tempPath = `${filePath}.codexswitch.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');

  try {
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    if (!e || (e.code !== 'EPERM' && e.code !== 'EACCES') || !fs.existsSync(filePath)) {
      throw e;
    }

    clearReadonlyAttribute(filePath);
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
  }
}

function writeFileWithPermissionRetry(filePath, content) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return;
    } catch (e) {
      lastError = e;
      if (!e || (e.code !== 'EPERM' && e.code !== 'EACCES')) {
        throw e;
      }

      clearReadonlyAttribute(filePath);
      if (attempt < 2) sleepMs(75 * (attempt + 1));
    }
  }

  if (!lastError || (lastError.code !== 'EPERM' && lastError.code !== 'EACCES')) {
    throw lastError;
  }

  clearReadonlyAttribute(filePath);
  writeFileAtomically(filePath, content);
}

function updateConfigToml(config) {
  try {
    fs.mkdirSync(CODEX_DIR, { recursive: true });

    const hasExistingConfig = fs.existsSync(CONFIG_TOML);
    const content = hasExistingConfig
      ? fs.readFileSync(CONFIG_TOML, 'utf8')
      : '';
    const eol = detectEol(content);
    const lines = toLines(content);

    const currentModelProvider = readTopLevelField(lines, 'model_provider');
    // A stale model_provider key (e.g. from a provider that was renamed or
    // removed) must not inherit the active section forever: switching to a new
    // provider while the referenced section is missing would edit or append an
    // orphan section that codex resolves only by the top-level key.
    let targetProviderKey = currentModelProvider || config.name || 'default';
    if (hasExistingConfig && config.name && currentModelProvider && !providerSectionExists(lines, targetProviderKey)) {
      targetProviderKey = config.name;
      upsertTopLevelField(lines, 'model_provider', targetProviderKey);
    }

    if (!hasExistingConfig && config.name) {
      upsertTopLevelField(lines, 'model_provider', config.name);
    }
    if (config.model) {
      upsertTopLevelField(lines, 'model', config.model);
    }
    if (config.name && config.baseUrl) {
      upsertProviderSection(lines, targetProviderKey, config.name, config.baseUrl);
    }

    writeFileWithPermissionRetry(CONFIG_TOML, fromLines(lines, eol));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateAuthJson(apiKey) {
  try {
    let authData = {};

    if (fs.existsSync(AUTH_JSON)) {
      const content = fs.readFileSync(AUTH_JSON, 'utf8');
      authData = JSON.parse(content);
    }

    authData.OPENAI_API_KEY = apiKey;

    fs.mkdirSync(CODEX_DIR, { recursive: true });
    writeFileWithPermissionRetry(AUTH_JSON, JSON.stringify(authData, null, 2));

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateClaudeSettings(config) {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });

    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
      settings = JSON.parse(content);
    }

    if (!settings.env) {
      settings.env = {};
    }

    delete settings.env.ANTHROPIC_API_KEY;

    if (config.ANTHROPIC_BASE_URL) {
      settings.env.ANTHROPIC_BASE_URL = config.ANTHROPIC_BASE_URL;
    }
    if (config.ANTHROPIC_AUTH_TOKEN) {
      settings.env.ANTHROPIC_AUTH_TOKEN = config.ANTHROPIC_AUTH_TOKEN;
    }
    if (config.model) {
      settings.model = config.model;
      settings.env.ANTHROPIC_MODEL = config.model;
    }

    writeFileWithPermissionRetry(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


const { resolveDeepSeekHarnessPaths, updateDeepSeekHarnessConfig, protocol: deepSeekProtocol } = require('./deepseek_config.cjs');

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tempPath, 0o600); } catch {}
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(filePath)) throw error;
    try { fs.chmodSync(filePath, 0o600); } catch {}
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function routerLockOwnerIsAlive(lockPath) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) throw new Error('Invalid router state lock owner');
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

async function withRouterStateLock(operation) {
  // Native Messaging starts a process per request. Atomic JSON replacement alone
  // cannot protect a read-modify-write transaction from another host process.
  fs.mkdirSync(CODEXSWITCH_DIR, { recursive: true, mode: 0o700 });
  const lockPath = `${ROUTER_STATE}.lock`;
  const recoveryPath = `${lockPath}.recovery`;
  const ownerPath = `${lockPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.owner`;
  // Publish already-complete owner metadata atomically, without an empty-lock gap.
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  let locked = false;
  const deadline = Date.now() + 15000;
  try {
    while (!locked) {
      // Guard both reclamation and publication: an owner can release its lock
      // and exit between reading its PID and checking liveness. No new owner
      // may publish a main lock until that check/removal has finished.
      let recovering = false;
      try {
        fs.linkSync(ownerPath, recoveryPath);
        recovering = true;
        const alive = routerLockOwnerIsAlive(lockPath);
        if (alive === false) fs.rmSync(lockPath, { force: true });
        if (alive !== true) { fs.linkSync(ownerPath, lockPath); locked = true; }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (routerLockOwnerIsAlive(recoveryPath) === false) throw new Error(`Interrupted router lock recovery; remove ${recoveryPath} and retry`);
      } finally {
        if (recovering) fs.rmSync(recoveryPath, { force: true });
      }
      if (locked) break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for router state lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return await operation();
  } finally {
    if (locked) fs.rmSync(lockPath, { force: true });
    fs.rmSync(ownerPath, { force: true });
  }
}

function readRouterToken() {
  if (!fs.existsSync(ROUTER_TOKEN)) return null;
  const saved = JSON.parse(fs.readFileSync(ROUTER_TOKEN, 'utf8'));
  if (!saved || saved.version !== 1 || typeof saved.localToken !== 'string' || !/^[a-f0-9]{64}$/.test(saved.localToken)) {
    throw new Error('Invalid router token file');
  }
  try { fs.chmodSync(ROUTER_TOKEN, 0o600); } catch {}
  return saved.localToken;
}

function getOrCreateRouterToken(fallbackToken) {
  const savedToken = readRouterToken();
  if (savedToken) return savedToken;
  const localToken = typeof fallbackToken === 'string' && /^[a-f0-9]{64}$/.test(fallbackToken)
    ? fallbackToken
    : crypto.randomBytes(32).toString('hex');
  writePrivateJson(ROUTER_TOKEN, { version: 1, localToken });
  return localToken;
}

function getRouterFiles() {
  const dsh = resolveDeepSeekHarnessPaths();
  return [
    { key: 'deepseekPatch', source: dsh.patchFile, backup: path.join(ROUTER_BACKUP_DIR, 'deepseek-patch.yml') },
    { key: 'deepseekCredentials', source: dsh.credentialsFile, backup: path.join(ROUTER_BACKUP_DIR, 'deepseek-credentials.yaml') },
    { key: 'codexConfig', source: CONFIG_TOML, backup: path.join(ROUTER_BACKUP_DIR, 'config.toml') },
    { key: 'codexAuth', source: AUTH_JSON, backup: path.join(ROUTER_BACKUP_DIR, 'auth.json') },
    { key: 'claudeSettings', source: CLAUDE_SETTINGS, backup: path.join(ROUTER_BACKUP_DIR, 'claude-settings.json') },
  ];
}

function clientFiles(format) {
  return getRouterFiles().filter(file => format === 'deepseek' ? file.key.startsWith('deepseek') : format === 'anthropic' ? file.key === 'claudeSettings' : file.key.startsWith('codex'));
}

function captureRouterBackup(format) {
  fs.mkdirSync(ROUTER_BACKUP_DIR, { recursive: true, mode: 0o700 });
  const manifest = format && fs.existsSync(ROUTER_BACKUP_MANIFEST) ? JSON.parse(fs.readFileSync(ROUTER_BACKUP_MANIFEST, 'utf8')) : { version: 1, files: {} };
  for (const file of format ? clientFiles(format) : getRouterFiles()) {
    const exists = fs.existsSync(file.source);
    manifest.files[file.key] = {
      source: file.source,
      exists,
      mode: exists ? fs.statSync(file.source).mode & 0o777 : null,
    };
    if (exists) {
      fs.copyFileSync(file.source, file.backup);
    }
  }
  writePrivateJson(ROUTER_BACKUP_MANIFEST, manifest);
}

function restoreRouterBackup() {
  if (!fs.existsSync(ROUTER_BACKUP_MANIFEST)) return;
  const manifest = JSON.parse(fs.readFileSync(ROUTER_BACKUP_MANIFEST, 'utf8'));
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Invalid router backup manifest');
  }

  for (const file of getRouterFiles()) {
    const entry = manifest.files[file.key];
    if (!entry && file.key.startsWith('deepseek')) continue; // Backups created before Harness support.
    if (!entry || typeof entry.exists !== 'boolean') throw new Error(`Router backup is incomplete: ${file.key}`);
    // Restore the original path even if DSH_HOME changed since enable. Older manifests use current paths.
    const source = entry.source || file.source;
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error(`Invalid router backup path: ${file.key}`);
    if (entry.exists) {
      if (!fs.existsSync(file.backup)) throw new Error(`Router backup file is missing: ${file.backup}`);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.copyFileSync(file.backup, source);
      const mode = Number.isInteger(entry.mode) ? entry.mode : fs.statSync(file.backup).mode & 0o777;
      try { fs.chmodSync(source, mode); } catch {}
    } else if (fs.existsSync(source)) {
      fs.rmSync(source, { force: true });
    }
  }
  fs.rmSync(ROUTER_BACKUP_DIR, { recursive: true, force: true });
}

function getRouterProviderConfig(config, { allowEmptyApiKey = false } = {}) {
  const provider = config && config.provider;
  if (!provider || typeof provider !== 'object') throw new Error('An active provider is required');
  const baseUrl = String(provider.baseUrl || '').trim();
  const apiKey = String(provider.apiKey || '').trim();
  if (!baseUrl || (!apiKey && !allowEmptyApiKey)) throw new Error(allowEmptyApiKey ? 'The provider must have a Base URL' : 'The provider must have a Base URL and API key');
  if (!['openai', 'anthropic', 'deepseek'].includes(provider.format)) throw new Error('Unsupported provider format');
  const apiType = ['chat', 'responses', 'messages', 'both', 'all'].includes(provider.apiType) ? provider.apiType : provider.format === 'deepseek' ? 'all' : 'chat';
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider URL must use http or https');
  return {
    id: String(provider.id || ''),
    name: String(provider.name || 'Provider'),
    baseUrl,
    apiKey,
    model: String(provider.model || ''),
    format: provider.format,
    apiType,
    selectedApiType: ['chat', 'responses', 'messages'].includes(provider.selectedApiType) ? provider.selectedApiType : undefined,
    formatConversionEnabled: provider.formatConversionEnabled === true,
    clientIdentity: normalizeClientIdentity(provider.clientIdentity),
  };
}

/**
 * Keeps only string header values so a malformed payload cannot inject
 * non-string objects into the upstream request.
 */
function normalizeClientIdentity(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const headers = raw.headers && typeof raw.headers === 'object'
    ? Object.fromEntries(Object.entries(raw.headers).filter(([, value]) => typeof value === 'string'))
    : {};
  const messagesHeaders = raw.messagesHeaders && typeof raw.messagesHeaders === 'object'
    ? Object.fromEntries(Object.entries(raw.messagesHeaders).filter(([, value]) => typeof value === 'string'))
    : {};
  const userAgent = typeof raw.userAgent === 'string' ? raw.userAgent : undefined;
  // Off is an explicit empty fingerprint, not an absent override. Dropping it
  // makes the Router fall back to the provider's previous/preset identity.
  if (!userAgent && Object.keys(headers).length === 0 && Object.keys(messagesHeaders).length === 0 && typeof raw.stripSdkHeaders !== 'boolean') return undefined;
  return { userAgent, headers, messagesHeaders, stripSdkHeaders: raw.stripSdkHeaders !== false };
}

function normalizeClientIdentityMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(['openai', 'anthropic', 'deepseek']
    .map(format => [format, normalizeClientIdentity(raw[format])])
    .filter(([, value]) => value));
}

function validateRouterPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Router port must be between 1 and 65535');
  }
  return port;
}

function normalizeRouterProxy(value) {
  const proxyUrl = String(value || '').trim();
  if (!proxyUrl) return '';
  const parsed = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Router proxy must use http or https');
  }
  if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Router proxy must be an http(s) URL without a path or query');
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error('Router proxy credentials must be URL-encoded');
  }
  return parsed.toString();
}

function writeCodexRouterConfig(port, localToken) {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const content = fs.existsSync(CONFIG_TOML) ? fs.readFileSync(CONFIG_TOML, 'utf8') : '';
  const lines = toLines(content);
  upsertTopLevelField(lines, 'model_provider', 'OpenAI');
  upsertTopLevelField(lines, 'model', 'router');
  upsertProviderSection(
    lines,
    'OpenAI',
    'router',
    `http://127.0.0.1:${port}/openai/v1`,
    { wire_api: '"responses"', requires_openai_auth: 'true' },
    ['env_key', 'experimental_bearer_token'],
  );
  writeFileWithPermissionRetry(CONFIG_TOML, fromLines(lines, detectEol(content)));

  let authData = {};
  if (fs.existsSync(AUTH_JSON)) authData = JSON.parse(fs.readFileSync(AUTH_JSON, 'utf8'));
  if (!authData || typeof authData !== 'object' || Array.isArray(authData)) {
    throw new Error('Codex auth.json must contain a JSON object');
  }
  authData.OPENAI_API_KEY = localToken;
  writePrivateJson(AUTH_JSON, authData);
}

function writeClaudeRouterConfig(port, localToken) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  let settings = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude settings.json must contain a JSON object');
  }
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)) settings.env = {};
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/anthropic`;
  settings.env.ANTHROPIC_AUTH_TOKEN = localToken;
  delete settings.env.ANTHROPIC_API_KEY;
  settings.env.ANTHROPIC_MODEL = 'router';
  settings.model = 'router';
  writePrivateJson(CLAUDE_SETTINGS, settings);
}

function writeRouterClientConfigs(port, localToken, formats = [], selectedApiType = 'chat') {
  const snapshots = getRouterFiles().filter(file => formats.some(format => clientFiles(format).some(client => client.key === file.key))).map(file => ({
    source: file.source,
    exists: fs.existsSync(file.source),
    content: fs.existsSync(file.source) ? fs.readFileSync(file.source) : null,
    mode: fs.existsSync(file.source) ? fs.statSync(file.source).mode & 0o777 : null,
  }));
  try {
    if (formats.includes('openai')) writeCodexRouterConfig(port, localToken);
    if (formats.includes('anthropic')) writeClaudeRouterConfig(port, localToken);
    if (formats.includes('deepseek')) {
      // The Harness entry follows the selected protocol; Anthropic's SDK appends /v1/messages itself.
      const api = deepSeekProtocol(selectedApiType);
      updateDeepSeekHarnessConfig({
        providerId: 'codexswitch-router', name: 'CodexSwitch Router', router: true,
        baseUrl: api === 'anthropic-messages' ? `http://127.0.0.1:${port}/deepseek` : `http://127.0.0.1:${port}/deepseek/v1`,
        api, apiKey: localToken, apiKeyEnv: 'CODEXSWITCH_ROUTER_KEY',
        providerKey: 'router', model: 'router', models: ['router'],
      });
    }
  } catch (error) {
    const restoreErrors = [];
    for (const snapshot of snapshots) {
      try {
        if (snapshot.exists) {
          writeFileWithPermissionRetry(snapshot.source, snapshot.content);
          fs.chmodSync(snapshot.source, snapshot.mode);
        } else {
          fs.rmSync(snapshot.source, { force: true });
        }
      } catch (restoreError) {
        restoreErrors.push(restoreError.message);
      }
    }
    if (restoreErrors.length) {
      throw new Error(`${error.message}; Failed to restore client configuration: ${restoreErrors.join('; ')}`);
    }
    throw error;
  }
}

function requestRouterHealth(port, localToken, timeoutMs = 500) {
  return new Promise(resolve => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      timeout: timeoutMs,
      headers: { 'x-codexswitch-control-token': localToken },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(response.statusCode === 200 && data.service === 'codexswitch-router' && data.running === true ? data : null);
        } catch { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startRouter(state) {
  const existing = await requestRouterHealth(state.port, state.localToken);
  if (existing) return existing;

  const routerScript = path.join(__dirname, 'codexswitch_router.cjs');
  if (!fs.existsSync(routerScript)) throw new Error(`Router script is missing: ${routerScript}`);
  fs.mkdirSync(CODEXSWITCH_DIR, { recursive: true, mode: 0o700 });
  const logPath = path.join(CODEXSWITCH_DIR, 'router.log');
  const logFd = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [routerScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CODEXSWITCH_ROUTER_STATE: ROUTER_STATE },
      windowsHide: true,
    });
    child.on('error', () => {});
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await requestRouterHealth(state.port, state.localToken);
    if (status) return status;
    await sleep(100);
  }
  throw new Error(`Router did not start on 127.0.0.1:${state.port}; see ${logPath}`);
}

async function stopRouter(state) {
  const status = await requestRouterHealth(state.port, state.localToken);
  if (!status) return;
  const pid = Number(status.pid);
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) throw new Error('Invalid router process ID');
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await requestRouterHealth(state.port, state.localToken))) return;
    await sleep(100);
  }
  throw new Error('Router process did not stop');
}

async function enableRouter(config) {
  const port = validateRouterPort(config.port);
  const proxyUrl = normalizeRouterProxy(config.proxyUrl);
  const provider = config.provider ? getRouterProviderConfig(config) : undefined;
  const providers = config.providers
    ? Object.fromEntries(['openai', 'anthropic', 'deepseek']
      .filter(format => config.providers[format])
      .map(format => [format, getRouterProviderConfig({ provider: config.providers[format] })]))
    : undefined;
  let previousState = null;
  if (fs.existsSync(ROUTER_STATE)) {
    const previous = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
    previousState = previous;
    if (previous.enabled) throw new Error('Router is already enabled');
  }
  const localToken = getOrCreateRouterToken(previousState && previousState.localToken);

  const state = {
    version: 1,
    enabled: true,
    host: '127.0.0.1',
    port,
    proxyUrl,
    localToken,
    provider,
    clients: {},
    providers: providers || (provider ? { [provider.format]: provider } : {}),
    clientIdentity: normalizeClientIdentityMap(config.clientIdentity || previousState?.clientIdentity),
    clientDisguise: normalizeClientIdentityMap(config.clientDisguise || previousState?.clientDisguise),
  };
  writePrivateJson(ROUTER_STATE, state);
  try {
    const status = await startRouter(state);
    return { success: true, data: { enabled: true, running: true, port, clients: state.clients, pid: status.pid } };
  } catch (error) {
    try { await stopRouter(state); } catch {}
    fs.rmSync(ROUTER_STATE, { force: true });
    fs.rmSync(ROUTER_PID, { force: true });
    throw error;
  }
}

async function setRouterProvider(config) {
  if (!fs.existsSync(ROUTER_STATE)) throw new Error('Router is not enabled');
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  if (!state.enabled) throw new Error('Router is not enabled');
  const provider = getRouterProviderConfig(config);
  const previousState = { ...state };
  if (config.targetFormat !== undefined && !['openai', 'anthropic', 'deepseek'].includes(config.targetFormat)) {
    throw new Error('Unsupported router target format');
  }
  if (config.targetFormat) {
    state.providers = { ...(state.providers || { openai: state.provider, anthropic: state.provider, deepseek: state.provider }), [config.targetFormat]: provider };

  } else if (state.providers) {
    state.providers = Object.fromEntries(Object.entries(state.providers).map(([format, current]) => [format, current && current.id === provider.id ? provider : current]));
  }
  state.provider = provider;
  writePrivateJson(ROUTER_STATE, state);
  try {
    const status = await requestRouterHealth(state.port, state.localToken) || await startRouter(state);
    return { success: true, data: { enabled: true, running: true, port: state.port, pid: status.pid, provider: provider.name } };
  } catch (error) {
    writePrivateJson(ROUTER_STATE, previousState);
    throw error;
  }
}

async function setRouterClientIdentity(config) {
  if (!fs.existsSync(ROUTER_STATE)) return { success: true, data: { enabled: false } };
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  state.clientIdentity = normalizeClientIdentityMap(config && config.clientIdentity);
  writePrivateJson(ROUTER_STATE, state);
  return { success: true, data: { enabled: state.enabled === true, running: state.enabled === true } };
}

async function setRouterClientDisguise(config) {
  if (!fs.existsSync(ROUTER_STATE)) return { success: true, data: { enabled: false } };
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  state.clientDisguise = normalizeClientIdentityMap(config && config.clientDisguise);
  writePrivateJson(ROUTER_STATE, state);
  return { success: true, data: { enabled: state.enabled === true, running: state.enabled === true } };
}

async function updateRouterSettings(config) {
  if (!fs.existsSync(ROUTER_STATE)) throw new Error('Router is not enabled');
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  if (!state.enabled) throw new Error('Router is not enabled');
  const port = validateRouterPort(config.port);
  const proxyUrl = normalizeRouterProxy(config.proxyUrl);
  const previousState = { ...state };
  const portChanged = port !== state.port;

  if (portChanged) await stopRouter(state);
  state.port = port;
  state.proxyUrl = proxyUrl;
  writePrivateJson(ROUTER_STATE, state);
  try {
    const status = portChanged
      ? await startRouter(state)
      : await requestRouterHealth(state.port, state.localToken) || await startRouter(state);
    if (!status) throw new Error('Router is not responding after settings update');
    if (portChanged) {
      writeRouterClientConfigs(port, state.localToken, Object.keys(state.clients || {}).filter(format => state.clients[format]), state.providers?.deepseek?.selectedApiType || 'chat');
    }
    return { success: true, data: { enabled: true, running: true, port, proxyUrl, pid: status.pid } };
  } catch (error) {
    if (portChanged) {
      try { await stopRouter(state); } catch {}
      writePrivateJson(ROUTER_STATE, previousState);
      try {
        await startRouter(previousState);
        writeRouterClientConfigs(previousState.port, previousState.localToken, Object.keys(previousState.clients || {}).filter(format => previousState.clients[format]), previousState.providers?.deepseek?.selectedApiType || 'chat');
      } catch {}
    } else {
      writePrivateJson(ROUTER_STATE, previousState);
    }
    throw error;
  }
}

async function getRouterStatus() {
  if (!fs.existsSync(ROUTER_STATE)) return { success: true, data: { enabled: false, running: false } };
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  if (!state.enabled) return { success: true, data: { enabled: false, running: false, port: state.port } };
  const status = await requestRouterHealth(state.port, state.localToken);
  return {
    success: true,
    data: {
      enabled: true,
      running: !!status,
      port: state.port,
      proxyUrl: state.proxyUrl || '',
      clients: state.clients || {},
      provider: state.provider && state.provider.name,
      pid: status && status.pid,
    },
  };
}

async function disableRouter() {
  let state = null;
  if (fs.existsSync(ROUTER_STATE)) state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  if (state && state.enabled) {
    if (Object.values(state.clients || {}).some(Boolean)) throw new Error('Switch all routed clients to direct before stopping the service');
    getOrCreateRouterToken(state.localToken);
    await stopRouter(state);
  }
  fs.rmSync(ROUTER_STATE, { force: true });
  fs.rmSync(ROUTER_PID, { force: true });
  return { success: true, data: { enabled: false, running: false } };
}

async function setClientRouting(config) {
  const format = config.format;
  if (!['openai', 'anthropic', 'deepseek'].includes(format)) throw new Error('Unsupported client format');
  if (!fs.existsSync(ROUTER_STATE)) throw new Error('Router is not enabled');
  const state = JSON.parse(fs.readFileSync(ROUTER_STATE, 'utf8'));
  const provider = getRouterProviderConfig(config);
  if (format !== provider.format && (format === 'deepseek' || provider.format === 'deepseek' || !provider.formatConversionEnabled)) throw new Error('Unsupported client conversion');
  const snapshots = clientFiles(format).map(file => ({ source: file.source, exists: fs.existsSync(file.source), content: fs.existsSync(file.source) ? fs.readFileSync(file.source) : null }));
  if (config.enabled && (!state.enabled || !await requestRouterHealth(state.port, state.localToken))) throw new Error('Router service is not running');
  if (!config.enabled && provider.format !== format) throw new Error('A native provider is required for direct connection');
  try {
    if (config.enabled) {
      if (!state.clients?.[format]) captureRouterBackup(format);
      writeRouterClientConfigs(state.port, state.localToken, [format], config.provider.selectedApiType || 'chat');
      state.providers = { ...(state.providers || {}), [format]: provider };
    } else {
      let result;
      if (format === 'anthropic') result = updateClaudeSettings({ ANTHROPIC_BASE_URL: provider.baseUrl.replace(/\/v1\/?$/, ''), ANTHROPIC_AUTH_TOKEN: provider.apiKey, model: provider.model });
      else if (format === 'deepseek') result = updateDeepSeekHarnessConfig({ ...provider, providerId: provider.id, name: provider.name, models: [provider.model], api: deepSeekProtocol(config.provider.selectedApiType || 'chat') });
      else { result = updateConfigToml(provider); if (result.success) result = updateAuthJson(provider.apiKey); }
      if (!result.success) throw new Error(result.error || 'Client configuration update failed');
    }
    state.clients = { ...(state.clients || {}), [format]: config.enabled === true };
    writePrivateJson(ROUTER_STATE, state);
  } catch (error) {
    for (const snapshot of snapshots) {
      if (snapshot.exists) writeFileWithPermissionRetry(snapshot.source, snapshot.content);
      else fs.rmSync(snapshot.source, { force: true });
    }
    throw error;
  }
  return getRouterStatus();
}

const routerStateActions = new Set([
  'setClientRouting', 'enableRouter', 'setRouterProvider', 'setClientIdentity', 'setClientDisguise',
  'updateRouterSettings', 'routerStatus', 'disableRouter', 'updateConfig', 'updateClaudeConfig',
  'updateDeepSeekHarnessConfig', 'updateDeepSeekConfig', 'updateDeepSeekHarness',
  'updateDeepSeekHarnessFallback', 'updateDeepSeekHarnessConfigFallback', 'updateDeepSeekConfigFallback',
]);

function handleMessage(message) {
  return routerStateActions.has(message && message.action)
    ? withRouterStateLock(() => dispatchMessage(message))
    : dispatchMessage(message);
}

async function dispatchMessage(message) {
  if (message && message.action === 'updateConfig') {
    const config = message.config || {};
    const tomlResult = updateConfigToml(config);
    const authResult = config.apiKey ? updateAuthJson(config.apiKey) : { success: true };
    return tomlResult.success && authResult.success
      ? { success: true }
      : { success: false, error: tomlResult.error || authResult.error };
  }
  if (message && message.action === 'updateClaudeConfig') return updateClaudeSettings(message.config || {});
  if (message && [
    'updateDeepSeekHarnessConfig',
    'updateDeepSeekConfig',
    'updateDeepSeekHarness',
    'updateDeepSeekHarnessFallback',
    'updateDeepSeekHarnessConfigFallback',
    'updateDeepSeekConfigFallback',
  ].includes(message.action)) return updateDeepSeekHarnessConfig(message.config || {}, message.action);
  if (message && message.action === 'testModelViaRouter') {
    const config = message.config || {};
    const provider = getRouterProviderConfig(config, { allowEmptyApiKey: true });
    provider.model = provider.model.trim();
    if (!provider.model) throw new Error('Select a model before testing');
    const proxyUrl = normalizeRouterProxy(config.proxyUrl);
    const targetFormat = config.targetFormat;
    if (targetFormat !== undefined && !['openai', 'anthropic', 'deepseek'].includes(targetFormat)) throw new Error('Unsupported model test target format');
    const data = await require('./codexswitch_router.cjs').testModelViaRouter(provider, proxyUrl, targetFormat);
    return { success: true, data };
  }
  if (message && message.action === 'setClientRouting') return setClientRouting(message.config || {});
  if (message && message.action === 'enableRouter') return enableRouter(message.config || {});
  if (message && message.action === 'setRouterProvider') return setRouterProvider(message.config || {});
  if (message && message.action === 'setClientIdentity') return setRouterClientIdentity(message.config || {});
  if (message && message.action === 'setClientDisguise') return setRouterClientDisguise(message.config || {});
  if (message && message.action === 'updateRouterSettings') return updateRouterSettings(message.config || {});
  if (message && message.action === 'routerStatus') return getRouterStatus();
  if (message && message.action === 'disableRouter') return disableRouter();
  if (message && message.action === 'ping') return { success: true, pong: true };
  return { success: false, error: 'Unknown action' };
}

try {
  const message = readSync();
  Promise.resolve(handleMessage(message))
    .then(writeSync)
    .catch(error => writeSync({ success: false, error: error.message || String(error) }));
} catch (error) {
  writeSync({ success: false, error: error.message });
}
