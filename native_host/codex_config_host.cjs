#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const AUTH_JSON = path.join(CODEX_DIR, 'auth.json');

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

function updateTopLevelField(lines, field, value) {
  const fieldLine = `${field} = "${escapeTomlString(value)}"`;
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < searchEnd; i += 1) {
    if (new RegExp(`^\s*${field}\s*=`).test(lines[i])) {
      lines[i] = fieldLine;
      return true;
    }
  }

  return false;
}

function readTopLevelField(lines, field) {
  const firstSectionIndex = lines.findIndex(line => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let i = 0; i < searchEnd; i += 1) {
    const match = lines[i].match(new RegExp(`^\\s*${field}\\s*=\\s*"((?:\\\\.|[^"])*)"\\s*$`));
    if (match) {
      return match[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }

  return null;
}

function formatProviderSectionHeader(name) {
  return /^[A-Za-z0-9_-]+$/.test(name)
    ? `[model_providers.${name}]`
    : `[model_providers."${escapeTomlString(name)}"]`;
}

function updateProviderSection(lines, sectionKey, providerName, baseUrl) {
  const header = formatProviderSectionHeader(sectionKey);
  const start = lines.findIndex(line => line.trim() === header);

  if (start === -1) {
    return false;
  }

  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end += 1;
  }

  const existingBody = lines.slice(start + 1, end);
  let updated = false;

  for (const [field, value] of [['name', providerName], ['base_url', baseUrl]]) {
    const replacement = `${field} = "${escapeTomlString(value)}"`;
    const idx = existingBody.findIndex(line => new RegExp(`^\s*${field}\s*=`).test(line));
    if (idx !== -1) {
      existingBody[idx] = replacement;
      updated = true;
    }
  }

  if (updated) {
    lines.splice(start, end - start, header, ...existingBody);
  }

  return updated;
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
    if (!fs.existsSync(CONFIG_TOML)) {
      return { success: false, error: 'config.toml not found' };
    }

    const content = fs.readFileSync(CONFIG_TOML, 'utf8');
    const eol = detectEol(content);
    const lines = toLines(content);

    const currentModelProvider = readTopLevelField(lines, 'model_provider');
    const targetProviderKey = currentModelProvider || config.name || 'default';

    if (config.model) {
      updateTopLevelField(lines, 'model', config.model);
    }
    if (config.name && config.baseUrl) {
      updateProviderSection(lines, targetProviderKey, config.name, config.baseUrl);
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

try {
  const message = readSync();

  if (message && message.action === 'updateConfig') {
    const config = message.config || {};

    const tomlResult = updateConfigToml(config);
    const authResult = config.apiKey ? updateAuthJson(config.apiKey) : { success: true };

    if (tomlResult.success && authResult.success) {
      writeSync({ success: true });
    } else {
      writeSync({ success: false, error: tomlResult.error || authResult.error });
    }
  } else if (message && message.action === 'ping') {
    writeSync({ success: true, pong: true });
  } else {
    writeSync({ success: false, error: 'Unknown action' });
  }
} catch (e) {
  writeSync({ success: false, error: e.message });
}
